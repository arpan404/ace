import { z } from "zod";
import { HostId, ThreadId, Timestamp } from "./ids.ts";
import { QueueFacts } from "./thread-transitions.ts";

/** Every thread state this build knows, without the fallback for newer ones. */
export const KnownThreadStatus = z.discriminatedUnion("state", [
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
   * Its work moved to another machine while it was working and goes on there (ADR 0191). Not
   * done and not settled: the thread there is the work; this one runs nothing more.
   */
  z.object({
    state: z.literal("moved"),
    to: z.object({ hostId: HostId, name: z.string().min(1).max(256), threadId: ThreadId }),
  }),
  /** Every agent idle, nothing pending, nothing running in the background. */
  z.object({ state: z.literal("done") }),
  z.object({ state: z.literal("new") }),
  /**
   * A state this build doesn't know, from a newer daemon: kept whole in `raw` (its `state` names
   * it). Never working and never done; clients show it neutrally.
   */
  z.object({ state: z.literal("unknown"), raw: z.record(z.string(), z.unknown()) }),
]);

const knownStates: ReadonlySet<unknown> = new Set(
  KnownThreadStatus.options.map((option) => option.shape.state.value),
);

/**
 * Thread status as shown in lists. Derived by the daemon from every agent, interaction,
 * background task and queued input in the thread. A state newer than this build reads as
 * `unknown` instead of failing the message around it, so the next new state can't drop a
 * client's socket.
 */
// A union, not `.catch()`: the protocol docs generator and browser workers leave `.catch()` out.
export const ThreadStatus = z.union([
  KnownThreadStatus,
  z
    .looseObject({
      state: z
        .string()
        .min(1)
        .max(64)
        .refine((state) => !knownStates.has(state)),
    })
    .transform((raw): { state: "unknown"; raw: Record<string, unknown> } => ({
      state: "unknown",
      raw,
    }))
    .meta({
      "x-ace-json-input": KnownThreadStatus,
      "x-ace-constraint": "A state this client doesn't know is read as `unknown`, kept in `raw`.",
    }),
]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;
