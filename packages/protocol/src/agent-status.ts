import { z } from "zod";
import { ItemId, Timestamp } from "./ids.ts";
import { ProviderErrorDetails } from "./provider-error-details.ts";

/** What the agent is doing right now while `working`. */
export const AgentActivity = z.enum([
  "thinking",
  "responding",
  "tool",
  "compacting",
  "retrying",
  "starting_turn",
]);
export type AgentActivity = z.infer<typeof AgentActivity>;

/** Why a non-idle agent is not making progress on its own output. */
export const BlockedReason = z.enum([
  /** An interaction is waiting for a person. */
  "human",
  /** Waiting for its own subagents to finish. */
  "subagents",
  /** Turn ended but a background shell, monitor or subagent is still live. */
  "background_task",
  "rate_limit",
  "network",
  /** Provider backend overloaded or unavailable; it is retrying on its own. */
  "upstream",
]);
export type BlockedReason = z.infer<typeof BlockedReason>;

export const AgentError = z.object({
  kind: z.enum(["provider", "auth", "quota", "network", "process_exit", "unknown"]),
  message: z.string(),
  code: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  details: ProviderErrorDetails.optional(),
});
export type AgentError = z.infer<typeof AgentError>;

export const AgentStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("starting") }),
  z.object({
    state: z.literal("working"),
    activity: AgentActivity,
    /** Tool call currently running, when `activity` is `tool`. */
    itemId: ItemId.optional(),
    /** Short provider-supplied description of the current step, if any. */
    detail: z.string().optional(),
  }),
  z.object({
    state: z.literal("blocked"),
    on: BlockedReason,
    /** Ids of the interactions, agents or background tasks it waits on. */
    refs: z.array(z.string()).default([]),
    /** For rate limits and retries: when the provider expects to try again. */
    until: Timestamp.optional(),
    /** Retry attempt number, when the provider reports one. */
    attempt: z.number().int().positive().optional(),
    /** Provider's own explanation, verbatim. */
    message: z.string().optional(),
  }),
  z.object({ state: z.literal("idle") }),
  /** Stopped by the user. Settled: counts as finished for thread "done". */
  z.object({ state: z.literal("interrupted") }),
  z.object({
    state: z.literal("failed"),
    error: AgentError,
  }),
  z.object({
    state: z.literal("unresponsive"),
    /** Last time any frame arrived for this agent. */
    lastSignalAt: Timestamp,
  }),
]);
export type AgentStatus = z.infer<typeof AgentStatus>;
