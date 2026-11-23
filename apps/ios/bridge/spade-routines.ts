import {
  parseSpadeHeartbeat,
  parseSpadeRoutine,
  parseSpadeRoutines,
  spadeAceEvents,
  spadeRoutineLine,
  spadeWhenInSentence,
  type SpadeHeartbeat,
  type SpadeRoutine,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { segment } from "./spade-text.ts";
import { spadeRefused, spadeRequestArea, type SpadeOutcome } from "./spade-requests-area.ts";

/*
 * A bot's routines and heartbeat on its profile (ADR 0129, spade/docs/routines.md): the list with
 * when each runs in words, pausing, Run now, Delete, the editor's Save and the heartbeat's. The
 * phone sends its own time zone with a schedule, which Spade reads it in, as web sends the
 * browser's.
 */

const agentPath = (agent: string, rest: string) => `/v1/agents/${segment(agent)}/${rest}`;
const agentId = z.string().min(1).max(256);
const routineId = z.string().min(1).max(256);
const timeZone = z.string().min(1).max(64);
const trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), schedule: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal("event"), event: z.enum(spadeAceEvents) }),
  z.object({ kind: z.literal("webhook") }),
]);
const clock = z.string().regex(/^\d{2}:\d{2}$/);

/** A routine as its row and its editor show it. */
export interface SpadeRoutineRow {
  id: string;
  name: string;
  instruction: string;
  /** When it runs in words, that it's paused, or that its last run failed. */
  line: string;
  failed: boolean;
  paused: boolean;
  /** Null when Spade sent a kind of trigger this client doesn't know: it isn't changed here. */
  trigger: z.infer<typeof trigger> | null;
}

export interface SpadeHeartbeatRow {
  enabled: boolean;
  everyMinutes: number;
  checklist: string;
  quiet: { start: string; end: string } | null;
  line: string;
}

export function routineRow(routine: SpadeRoutine, now: number): SpadeRoutineRow {
  const said = spadeRoutineLine(routine, now);
  return {
    id: routine.id,
    name: routine.name,
    instruction: routine.instruction,
    line: said.text,
    failed: said.failed,
    paused: routine.paused,
    trigger: routine.trigger ?? null,
  };
}

const every = (minutes: number) => {
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
};

/** The heartbeat's line, as web's row says it: `Every 30 minutes · quiet 22:00 to 07:00 · next 9:30`. */
export function heartbeatRow(beat: SpadeHeartbeat, now: number): SpadeHeartbeatRow {
  const line = !beat.enabled
    ? "Off"
    : [
        every(beat.everyMinutes),
        beat.quiet && `quiet ${beat.quiet.start} to ${beat.quiet.end}`,
        beat.nextRun !== undefined &&
          `next ${spadeWhenInSentence(beat.nextRun, now, beat.timeZone)}`,
      ]
        .filter(Boolean)
        .join(" · ");
  return {
    enabled: beat.enabled,
    everyMinutes: beat.everyMinutes,
    checklist: beat.checklist,
    quiet: beat.quiet ?? null,
    line,
  };
}

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

type Answer =
  | SpadeOutcome
  | { ok: true; routines: SpadeRoutineRow[]; heartbeat: SpadeHeartbeatRow | null }
  | { ok: true; routine: SpadeRoutineRow };

export const spadeRoutineRequests = spadeRequestArea(
  [
    /** The bot's routines, oldest first, and its heartbeat. */
    z.object({ type: z.literal("spade.routines"), agentId }),
    /** A new routine (no `id`) or a change to one; `trigger` only when the person changed it. */
    z.object({
      type: z.literal("spade.routine.save"),
      agentId,
      id: routineId.optional(),
      name: z.string().trim().min(1).max(60),
      instruction: z.string().trim().min(1).max(4000),
      trigger: trigger.optional(),
      timeZone,
    }),
    z.object({ type: z.literal("spade.routine.pause"), id: routineId, paused: z.boolean() }),
    z.object({ type: z.literal("spade.routine.run"), id: routineId }),
    z.object({ type: z.literal("spade.routine.delete"), id: routineId }),
    /** The heartbeat's switch, or its editor's Save (which turns it on). */
    z.object({
      type: z.literal("spade.heartbeat.save"),
      agentId,
      enabled: z.boolean(),
      everyMinutes: z.number().int().min(5).max(1440).optional(),
      checklist: z.string().trim().max(4000).optional(),
      quiet: z.object({ start: clock, end: clock }).nullable().optional(),
      /** Sent only with quiet hours or an interval: a switch alone keeps the zone they were set in. */
      timeZone: timeZone.optional(),
    }),
  ],
  async ({ ask, deps }, request): Promise<Answer> => {
    switch (request.type) {
      case "spade.routines":
        try {
          const [list, beat] = await Promise.all([
            ask("GET", agentPath(request.agentId, "routines")),
            // A heartbeat Spade can't read leaves the routines to show.
            ask("GET", agentPath(request.agentId, "heartbeat")).catch(() => ""),
          ]);
          const now = deps.now();
          const heartbeat = parseSpadeHeartbeat(beat);
          return {
            ok: true,
            routines: sure(parseSpadeRoutines(list), "routines").map((each) =>
              routineRow(each, now),
            ),
            heartbeat: heartbeat ? heartbeatRow(heartbeat, now) : null,
          };
        } catch (error) {
          return spadeRefused("Couldn't read the routines", error);
        }
      case "spade.routine.save":
        try {
          const { id, name, instruction } = request;
          // A schedule the person writes or rewrites is meant in their zone now.
          const when = request.trigger
            ? { trigger: request.trigger, time_zone: request.timeZone }
            : {};
          if (!id && !request.trigger) throw new Error("Say when it runs.");
          const body = id
            ? await ask("PATCH", `/v1/routines/${segment(id)}`, { name, instruction, ...when })
            : await ask("POST", agentPath(request.agentId, "routines"), {
                name,
                instruction,
                ...when,
              });
          return {
            ok: true,
            routine: routineRow(sure(parseSpadeRoutine(body), "routine"), deps.now()),
          };
        } catch (error) {
          return spadeRefused("Couldn't save the routine", error);
        }
      case "spade.routine.pause":
        try {
          await ask("PATCH", `/v1/routines/${segment(request.id)}`, { paused: request.paused });
          return { ok: true };
        } catch (error) {
          return spadeRefused(request.paused ? "Couldn't pause it" : "Couldn't resume it", error);
        }
      case "spade.routine.run":
        try {
          await ask("POST", `/v1/routines/${segment(request.id)}/run`);
          return { ok: true };
        } catch (error) {
          return spadeRefused("Couldn't run it", error);
        }
      case "spade.routine.delete":
        try {
          await ask("DELETE", `/v1/routines/${segment(request.id)}`);
          return { ok: true };
        } catch (error) {
          return spadeRefused("Couldn't delete it", error);
        }
      case "spade.heartbeat.save":
        try {
          const { enabled, everyMinutes, checklist, quiet, timeZone: zone } = request;
          await ask("PUT", agentPath(request.agentId, "heartbeat"), {
            enabled,
            ...(everyMinutes === undefined ? {} : { every_minutes: everyMinutes }),
            ...(checklist === undefined ? {} : { checklist }),
            ...(quiet === undefined ? {} : { quiet }),
            ...(zone === undefined ? {} : { time_zone: zone }),
          });
          return { ok: true };
        } catch (error) {
          return spadeRefused(
            request.enabled ? "Couldn't turn the heartbeat on" : "Couldn't turn the heartbeat off",
            error,
          );
        }
    }
  },
);
