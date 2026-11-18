import { z } from "zod";
import { HostId, ThreadId, Timestamp } from "./ids.ts";
import { QueueFacts } from "./thread-transitions.ts";

/**
 * Thread status as shown in lists. Derived by the daemon from every agent,
 * interaction, background task and queued input in the thread.
 */
export const ThreadStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("needs_you"), interactions: z.number().int().positive() }),
  z.object({ state: z.literal("working"), agents: z.number().int().positive() }),
  z.object({
    state: z.literal("waiting"),
    on: z.enum(["background_task", "rate_limit", "network", "upstream", "queue"]),
    /** While queued past its parent's run slots: where the child stands. */
    ...QueueFacts.partial().shape,
  }),
  z.object({ state: z.literal("limited"), until: Timestamp.optional() }),
  z.object({ state: z.literal("failed") }),
  z.object({ state: z.literal("unresponsive") }),
  /**
   * Its work moved to another machine while it was working and goes on there (ADR 0190). Not
   * done and not settled: the thread there is the work; this one runs nothing more.
   */
  z.object({
    state: z.literal("moved"),
    to: z.object({ hostId: HostId, name: z.string().min(1).max(256), threadId: ThreadId }),
  }),
  /** Every agent idle, nothing pending, nothing running in the background. */
  z.object({ state: z.literal("done") }),
  z.object({ state: z.literal("new") }),
]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;
