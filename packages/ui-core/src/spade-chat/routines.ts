import { z } from "zod";
import { spadeJson } from "./json.ts";

/*
 * A bot's routines and heartbeat (ADR 0129, spade/docs/routines.md), as Spade's API sends them,
 * and the few words the list shows for each.
 */

export const spadeAceEvents = ["thread_done", "thread_failed", "thread_needs_you"] as const;
export type SpadeAceEvent = (typeof spadeAceEvents)[number];

export type SpadeTrigger =
  | { kind: "schedule"; schedule: string }
  | { kind: "event"; event: SpadeAceEvent }
  | { kind: "webhook" };

export type SpadeRunResult =
  | "running"
  | "answered"
  | "quiet"
  | "failed"
  | "stopped"
  | "interrupted"
  | "skipped";

export interface SpadeRun {
  id: string;
  at: number;
  cause: string;
  result: SpadeRunResult;
  detail: string | undefined;
}

export interface SpadeRoutine {
  id: string;
  name: string;
  instruction: string;
  /** Undefined when Spade sent a trigger this client doesn't know. */
  trigger: SpadeTrigger | undefined;
  /** The trigger in Spade's words: `Weekdays at 9:00`. */
  words: string;
  timeZone: string;
  paused: boolean;
  nextRun: number | undefined;
  lastRun: SpadeRun | undefined;
  webhook: { path: string; secret: string } | undefined;
  createdBy: "person" | "agent";
}

export interface SpadeHeartbeat {
  enabled: boolean;
  everyMinutes: number;
  checklist: string;
  quiet: { start: string; end: string } | undefined;
  timeZone: string;
  nextRun: number | undefined;
  lastRun: SpadeRun | undefined;
}

const time = z.number().int().nonnegative();
const trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), schedule: z.string() }),
  z.object({ kind: z.literal("event"), event: z.enum(spadeAceEvents) }),
  z.object({ kind: z.literal("webhook") }),
]);
const runShape = z.object({
  id: z.string(),
  at: time.catch(0),
  cause: z.string().catch(""),
  result: z
    .enum(["running", "answered", "quiet", "failed", "stopped", "interrupted", "skipped"])
    .catch("running"),
  detail: z.string().nullish().catch(undefined),
});
const routine = z.object({
  id: z.string(),
  name: z.string().catch(""),
  instruction: z.string().catch(""),
  trigger: trigger.optional().catch(undefined),
  words: z.string().catch(""),
  time_zone: z.string().catch("UTC"),
  paused: z.boolean().catch(false),
  next_run: time.nullish().catch(undefined),
  last_run: runShape.nullish().catch(undefined),
  webhook: z.object({ path: z.string(), secret: z.string() }).nullish().catch(undefined),
  created_by: z.enum(["person", "agent"]).catch("person"),
});
const heartbeat = z.object({
  enabled: z.boolean().catch(false),
  every_minutes: z.number().int().positive().catch(30),
  checklist: z.string().catch(""),
  quiet: z.object({ start: z.string(), end: z.string() }).nullish().catch(undefined),
  time_zone: z.string().catch("UTC"),
  next_run: time.nullish().catch(undefined),
  last_run: runShape.nullish().catch(undefined),
});

function runOf(raw: z.infer<typeof runShape> | null | undefined): SpadeRun | undefined {
  if (!raw) return undefined;
  return {
    id: raw.id,
    at: raw.at,
    cause: raw.cause,
    result: raw.result,
    detail: raw.detail ?? undefined,
  };
}

function routineOf(raw: z.infer<typeof routine>): SpadeRoutine {
  return {
    id: raw.id,
    name: raw.name || "Routine",
    instruction: raw.instruction,
    trigger: raw.trigger,
    words: raw.words,
    timeZone: raw.time_zone,
    paused: raw.paused,
    nextRun: raw.next_run ?? undefined,
    lastRun: runOf(raw.last_run),
    webhook: raw.webhook ?? undefined,
    createdBy: raw.created_by,
  };
}

const routinesBody = z.object({ routines: z.array(z.unknown()) });
const routineBody = z.object({ routine });
const heartbeatBody = z.object({ heartbeat });

/** `{"routines":[…]}`; a routine this client can't read is left out. Undefined if not a list. */
export function parseSpadeRoutines(text: string): SpadeRoutine[] | undefined {
  const body = routinesBody.safeParse(spadeJson(text));
  if (!body.success) return undefined;
  return body.data.routines.flatMap((each) => {
    const parsed = routine.safeParse(each);
    return parsed.success ? [routineOf(parsed.data)] : [];
  });
}

/** `{"routine":…}`. */
export function parseSpadeRoutine(text: string): SpadeRoutine | undefined {
  const body = routineBody.safeParse(spadeJson(text));
  return body.success ? routineOf(body.data.routine) : undefined;
}

/** `{"heartbeat":…}`. */
export function parseSpadeHeartbeat(text: string): SpadeHeartbeat | undefined {
  const body = heartbeatBody.safeParse(spadeJson(text));
  if (!body.success) return undefined;
  const raw = body.data.heartbeat;
  return {
    enabled: raw.enabled,
    everyMinutes: raw.every_minutes,
    checklist: raw.checklist,
    quiet: raw.quiet ?? undefined,
    timeZone: raw.time_zone,
    nextRun: raw.next_run ?? undefined,
    lastRun: runOf(raw.last_run),
  };
}

/** How a run went, in a few words: `Answered`, `Skipped: the last run was still going.` */
export function spadeRunWords(run: SpadeRun): string {
  switch (run.result) {
    case "running":
      return "Running";
    case "answered":
      return "Answered";
    case "quiet":
      return "Nothing to report";
    case "stopped":
      return "Stopped";
    case "interrupted":
      return "Cut off by a restart";
    case "failed":
      return run.detail ? `Failed: ${run.detail}` : "Failed";
    case "skipped":
      return run.detail ? `Skipped. ${run.detail}` : "Skipped";
  }
}

/**
 * When something runs, relative to `now` in `timeZone`: `9:00` today, `Tomorrow 9:00`, `Fri
 * 9:00` within a week, else `Nov 20, 9:00`.
 */
export function spadeWhen(at: number, now: number, timeZone: string): string {
  const zone = safeZone(timeZone);
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" }).format(ms);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  const days = Math.round((Date.parse(day(at)) - Date.parse(day(now))) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `Tomorrow ${clock}`;
  if (days === -1) return `Yesterday ${clock}`;
  if (days > 1 && days < 7) {
    const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short" });
    return `${weekday.format(at)} ${clock}`;
  }
  const date = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" });
  return `${date.format(at)}, ${clock}`;
}

function safeZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}
