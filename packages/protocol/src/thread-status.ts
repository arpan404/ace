import { z } from "zod";
import { Timestamp } from "./ids.ts";

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
  }),
  z.object({ state: z.literal("limited"), until: Timestamp.optional() }),
  z.object({ state: z.literal("failed") }),
  z.object({ state: z.literal("unresponsive") }),
  /** Every agent idle, nothing pending, nothing running in the background. */
  z.object({ state: z.literal("done") }),
  z.object({ state: z.literal("new") }),
]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;
