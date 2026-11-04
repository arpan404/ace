import { DelegationFailure } from "./delegation-failure.ts";
import { z } from "zod";
import { InteractionId, ThreadId } from "./ids.ts";
import { RemoteContact } from "./agent.ts";
import { QueueFacts } from "./thread-transitions.ts";

/**
 * Bounded waits and compact monitoring for agents that delegate or control other threads.
 * Small fields keep every result cheap for a model to read.
 */
export const WaitMode = z.enum(["any", "all"]);
export type WaitMode = z.infer<typeof WaitMode>;
/** At most ten minutes, so a wait never holds a provider turn indefinitely. */
export const WaitTimeoutSeconds = z.number().int().min(1).max(600);
/** How many threads one wait may watch: every child of the largest batch. */
export const maxWaitThreads = 64;
export const WaitInput = {
  threadIds: z.array(ThreadId).min(1).max(maxWaitThreads),
  mode: WaitMode.default("all"),
  timeoutSeconds: WaitTimeoutSeconds.default(120),
};
/** `queued`: delegated past its parent's run slots, it starts when a running sibling finishes. */
export const WatchedState = z.enum([
  "working",
  "queued",
  "needs_you",
  "done",
  "failed",
  "cancelled",
]);
export type WatchedState = z.infer<typeof WatchedState>;
export const WatchedRequest = z.object({
  interactionId: InteractionId,
  kind: z.string().max(64),
  /** What the person is asked, abbreviated. */
  prompt: z.string().max(240),
});
export type WatchedRequest = z.infer<typeof WatchedRequest>;
export const WatchedThread = z.object({
  failure: DelegationFailure.optional(),
  threadId: ThreadId,
  state: WatchedState,
  title: z.string().max(120),
  elapsedSeconds: z.number().int().nonnegative(),
  /** The current step while working, e.g. `tool` or the provider's own short description. */
  step: z.string().max(120).optional(),
  /** While queued past its parent's run slots: where it stands. */
  ...QueueFacts.partial().shape,
  /** Final answer excerpt once done, failed or cancelled. */
  result: z.string().max(4096).optional(),
  truncated: z.boolean().optional(),
  /** The latest output line while still working. */
  last: z.string().max(160).optional(),
  /** Requests waiting on the person, in this thread or its descendants. */
  needs: z.array(WatchedRequest).max(8).optional(),
  /** The paired machine this child runs on, when it is not this one (ADR 0078). */
  machine: z.string().max(64).optional(),
  /**
   * A child on another machine that this machine can't vouch for (ADR 0052): `lost` (its machine
   * stopped reporting; read as `failed`, so it no longer holds a wait) or `unconfirmed` (stopped
   * here, read as `cancelled`, though its machine never confirmed it). Only this machine sets it.
   */
  contact: RemoteContact.optional(),
});
export type WatchedThread = z.infer<typeof WatchedThread>;
export const WaitStatus = z.enum([
  /** The wait condition was met: any or all settled. */
  "ready",
  /** A watched thread needs the person; returned early in both modes. */
  "needs_you",
  /**
   * A watched thread's turn ended on its provider's usage limit and nothing runs until the limit
   * resets or someone switches it; returned early in both modes when nothing has settled.
   */
  "limited",
  /** The timeout elapsed first; work continues and the agent may wait again. */
  "timeout",
  /** The daemon is stopping or restarting; work is retained and the agent may wait again. */
  "interrupted",
]);
export type WaitStatus = z.infer<typeof WaitStatus>;
export const WaitResult = z.object({
  status: WaitStatus,
  mode: WaitMode,
  threads: z.array(WatchedThread).max(maxWaitThreads),
});
export type WaitResult = z.infer<typeof WaitResult>;
/**
 * A snapshot row's state. `unknown`: ace could not read this child's facts. It is never settled,
 * so an unreadable child can't make its parent look done. `cancelling`: a child on another
 * machine was stopped here, and ace keeps sending the cancel until that machine confirms it
 * ended; its work there may still be running. A wait reads it as cancelled, so it never holds
 * its parent on a machine that may never answer again.
 */
export const MonitoredState = z.enum([...WatchedState.options, "unknown", "cancelling"]);
export type MonitoredState = z.infer<typeof MonitoredState>;
/** How many children one snapshot lists; `counts` and `omitted` cover the rest. */
export const maxMonitoredChildren = 64;
/** One child in a compact tree snapshot. */
export const MonitoredChild = z.object({
  failure: DelegationFailure.optional(),
  result: z.string().max(4096).optional(),
  id: ThreadId,
  /** Present when the child belongs to another child rather than the caller. */
  parent: ThreadId.optional(),
  role: z.string().max(40),
  state: MonitoredState,
  step: z.string().max(60).optional(),
  /** While queued past its parent's run slots: where it stands. */
  ...QueueFacts.partial().shape,
  elapsedSeconds: z.number().int().nonnegative(),
  /** Number of requests waiting on the person and the first one, abbreviated. */
  needs: z.number().int().positive().optional(),
  ask: z.string().max(100).optional(),
  last: z.string().max(100).optional(),
  /** Messages waiting in its queue, a parent's included: they have not reached it yet. */
  queued: z.number().int().positive().optional(),
  /** A message to it that failed or was kept back after it was accepted, and what ace did. */
  notice: z.string().max(400).optional(),
  machine: z.string().max(64).optional(),
  /** See WatchedThread.contact. */
  contact: RemoteContact.optional(),
});
export type MonitoredChild = z.infer<typeof MonitoredChild>;
export const MonitorSnapshot = z.object({
  /** Unsettled children first, so a full list never hides one that still works or waits. */
  children: z.array(MonitoredChild).max(maxMonitoredChildren),
  /** Children left out because the list is full; `counts` includes them. */
  omitted: z.number().int().positive().optional(),
  /** Children in each state, the whole tree. */
  counts: z.object({
    working: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    needs_you: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    cancelling: z.number().int().nonnegative(),
  }),
});
export type MonitorSnapshot = z.infer<typeof MonitorSnapshot>;
