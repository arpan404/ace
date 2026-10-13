import { z } from "zod";
import { InteractionId, ThreadId } from "./ids.ts";

/**
 * Bounded waits and compact monitoring for agents that delegate or control other threads.
 * Small fields keep every result cheap for a model to read.
 */
export const WaitMode = z.enum(["any", "all"]);
export type WaitMode = z.infer<typeof WaitMode>;
/** At most ten minutes, so a wait never holds a provider turn indefinitely. */
export const WaitTimeoutSeconds = z.number().int().min(1).max(600);
export const WaitInput = {
  threadIds: z.array(ThreadId).min(1).max(16),
  mode: WaitMode.default("all"),
  timeoutSeconds: WaitTimeoutSeconds.default(120),
};
export const WatchedState = z.enum(["working", "needs_you", "done", "failed", "cancelled"]);
export type WatchedState = z.infer<typeof WatchedState>;
export const WatchedRequest = z.object({
  interactionId: InteractionId,
  kind: z.string().max(64),
  /** What the person is asked, abbreviated. */
  prompt: z.string().max(240),
});
export type WatchedRequest = z.infer<typeof WatchedRequest>;
export const WatchedThread = z.object({
  threadId: ThreadId,
  state: WatchedState,
  title: z.string().max(120),
  elapsedSeconds: z.number().int().nonnegative(),
  /** The current step while working, e.g. `tool` or the provider's own short description. */
  step: z.string().max(120).optional(),
  /** Final answer excerpt once done, failed or cancelled. */
  result: z.string().max(4096).optional(),
  truncated: z.boolean().optional(),
  /** The latest output line while still working. */
  last: z.string().max(160).optional(),
  /** Requests waiting on the person, in this thread or its descendants. */
  needs: z.array(WatchedRequest).max(8).optional(),
});
export type WatchedThread = z.infer<typeof WatchedThread>;
export const WaitStatus = z.enum([
  /** The wait condition was met: any or all settled. */
  "ready",
  /** A watched thread needs the person; returned early in both modes. */
  "needs_you",
  /** The timeout elapsed first; work continues and the agent may wait again. */
  "timeout",
  /** The daemon is stopping or restarting; work is retained and the agent may wait again. */
  "interrupted",
]);
export type WaitStatus = z.infer<typeof WaitStatus>;
export const WaitResult = z.object({
  status: WaitStatus,
  mode: WaitMode,
  threads: z.array(WatchedThread).max(16),
});
export type WaitResult = z.infer<typeof WaitResult>;
/** One child in a compact tree snapshot. */
export const MonitoredChild = z.object({
  id: ThreadId,
  /** Present when the child belongs to another child rather than the caller. */
  parent: ThreadId.optional(),
  role: z.string().max(40),
  state: WatchedState,
  step: z.string().max(60).optional(),
  elapsedSeconds: z.number().int().nonnegative(),
  /** Number of requests waiting on the person and the first one, abbreviated. */
  needs: z.number().int().positive().optional(),
  ask: z.string().max(100).optional(),
  last: z.string().max(100).optional(),
});
export type MonitoredChild = z.infer<typeof MonitoredChild>;
export const MonitorSnapshot = z.object({
  children: z.array(MonitoredChild).max(64),
  /** Children in each state. */
  counts: z.object({
    working: z.number().int().nonnegative(),
    needs_you: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
});
export type MonitorSnapshot = z.infer<typeof MonitorSnapshot>;
