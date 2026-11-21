import { z } from "zod";

/*
 * The stored events of Spade's capability ADRs that the chat reads: goals and the check of done
 * (ADR 0159), wakes (ADR 0160) and workers (ADR 0161), as `spade_core::event` writes them. Read
 * leniently like every event in `wire.ts`: a field this client doesn't know is ignored, a value
 * it can't read falls back, and a body that doesn't fit stays an unknown event.
 */

const words = z.string().catch("").default("");

/** How a worker settled (`ReportState`); a state a later Spade adds reads as `other`. */
export const spadeWorkerStates = [
  "done",
  "finished",
  "needs_you",
  "parked",
  "failed",
  "stopped",
  "stopping",
  "other",
] as const;
export type SpadeWorkerState = (typeof spadeWorkerStates)[number];

/** A bot made with `bot_create`, or an ace thread started with `delegate`. */
const workerKind = z.enum(["bot", "ace", "helper"]).catch("bot");

/** What a wake is for (`wake::Purpose`), by its `kind`; an unknown one reads as a plain wait. */
const purpose = z
  .looseObject({
    kind: z.enum(["sleep", "wait", "retry", "outage", "park"]).catch("wait"),
    error: z.string().optional().catch(undefined),
    reason: z.string().optional().catch(undefined),
  })
  .catch({ kind: "wait" });

/** What a `wait_for` waits for (`wake::Condition`), kept whole: `spadeRestLine` reads it. */
const condition = z.looseObject({ kind: z.string() }).nullish().catch(undefined);

export const spadeCapabilityEvents = [
  /** The task's goal: the person's words, a short title and the criteria for done. */
  z.object({
    type: z.literal("goal_set"),
    goal: z.string(),
    title: words,
    text: words,
    by: z.enum(["bot", "person"]).catch("bot").default("bot"),
  }),
  /** The verifier judged a claim of done: done, not yet (with what is missing) or unchecked. */
  z.object({
    type: z.literal("task_verified"),
    goal: z.string(),
    verdict: z.enum(["done", "not_yet", "unchecked"]).catch("unchecked"),
    missing: z.array(z.unknown()).catch([]).default([]),
  }),
  /** The bot made a worker, or started an ace thread as one. */
  z.object({
    type: z.literal("worker_started"),
    worker: z.string(),
    kind: workerKind,
    name: words,
    /** The call that started it: one `delegate` starting several shares it. */
    call: words,
  }),
  /** A worker settled; `summary` is Spade's words on how, never the worker's own. */
  z.object({
    type: z.literal("worker_reported"),
    worker: z.string(),
    kind: workerKind,
    name: words,
    state: z.enum(spadeWorkerStates).catch("other"),
    summary: words,
  }),
  /** The bot will be woken: at `due_ms`, when `condition` happens, or both. */
  z.object({
    type: z.literal("wake_set"),
    wake: z.string(),
    reply: words,
    purpose,
    due_ms: z.number().nullish().catch(undefined),
    condition,
    reason: words,
  }),
  z.object({ type: z.literal("wake_fired"), wake: z.string() }),
  /** An owned service started: only its name is read, for the words of a wait on it. */
  z.object({ type: z.literal("service_started"), service: z.string(), name: words }),
  z.object({ type: z.literal("wake_cancelled"), wake: z.string() }),
] as const;
