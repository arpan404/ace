import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * A bot's task lanes (ADR 0217), as `GET /v1/conversations/{id}/tasks` answers them: each task
 * the bot runs in a conversation of its own beside its main one, already in the list's order
 * (needs you, running, ended, queued). Each lane's own conversation is read, written to,
 * stopped and tried again like any conversation: `/events` and `/live`, `/messages`, `/stop`,
 * `/retry`. Parsed leniently: a row this client can't read is left out, a state it doesn't know
 * reads as working, so a lane never reads ended while it may still run.
 */

export const spadeLaneStates = [
  "needs_you",
  "working",
  "done",
  "finished",
  "failed",
  "stopped",
  "queued",
] as const;
export type SpadeLaneState = (typeof spadeLaneStates)[number];

export interface SpadeLane {
  /** The lane's id; its conversation's id too. */
  task: string;
  conversation: string;
  /** In the person's words. */
  title: string;
  state: SpadeLaneState;
  needsYou: boolean;
  /** The plan's items closed of all, while it has a plan. */
  progress: { done: number; total: number; verified: number } | undefined;
  /** The plan item it works on now, while it runs. */
  planStep: string | undefined;
  startedMs: number;
  endedMs: number | undefined;
  /** What its steps cost; shown, never capped (ADR 0166). */
  costMicros: number;
  /** The asks of main's ledger it owns. */
  asks: readonly string[];
  /** Spade moved main's long work here (ADR 0217 §2a). */
  moved: boolean;
  /** The model its steps run on: the bot's `task` role (ADR 0217 §8a). */
  model: string | undefined;
  /** The first line of its last words, once it has ended. */
  report: string | undefined;
}

const count = z.number().int().nonnegative().catch(0).default(0);

const laneShape = z.object({
  task: z.string().min(1),
  conversation: z.string().min(1),
  title: z.string().catch("A task").default("A task"),
  state: z.enum(spadeLaneStates).catch("working"),
  needs_you: z.boolean().catch(false).default(false),
  progress: z.object({ done: count, total: count, verified: count }).nullish().catch(undefined),
  plan_step: z.string().nullish().catch(undefined),
  started_ms: z.number().catch(0).default(0),
  ended_ms: z.number().nullish().catch(undefined),
  cost_micros: z.number().nonnegative().catch(0).default(0),
  asks: z.array(z.string()).catch([]).default([]),
  moved: z.boolean().catch(false).default(false),
  model: z.string().nullish().catch(undefined),
  report: z.string().nullish().catch(undefined),
});

function readLane(value: unknown): SpadeLane | undefined {
  const parsed = laneShape.safeParse(value);
  if (!parsed.success) return undefined;
  const lane = parsed.data;
  return {
    task: lane.task,
    conversation: lane.conversation,
    title: lane.title || "A task",
    state: lane.state,
    needsYou: lane.needs_you || lane.state === "needs_you",
    progress: lane.progress ?? undefined,
    planStep: lane.plan_step || undefined,
    startedMs: lane.started_ms,
    endedMs: lane.ended_ms ?? undefined,
    costMicros: lane.cost_micros,
    asks: lane.asks,
    moved: lane.moved,
    model: lane.model || undefined,
    report: lane.report || undefined,
  };
}

/** `{"tasks": [...]}` in the order Spade sent it; empty when the body makes no sense. */
export function parseSpadeLanes(body: string): SpadeLane[] {
  const tasks = spadeRecord(spadeJson(body))?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((value) => {
    const lane = readLane(value);
    return lane ? [lane] : [];
  });
}

/** Whether the lane hasn't ended: the bot never reads idle or done while one hasn't. */
export const spadeLaneLive = (lane: Pick<SpadeLane, "state">) =>
  lane.state === "working" || lane.state === "needs_you" || lane.state === "queued";
