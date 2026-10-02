import { z } from "zod";
import { AgentId, ItemId, ThreadId, Timestamp } from "./ids.ts";
import { NativeRef } from "./provider.ts";

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
    error: z.object({
      kind: z.enum(["provider", "auth", "quota", "network", "process_exit", "unknown"]),
      message: z.string(),
    }),
  }),
  z.object({
    state: z.literal("unresponsive"),
    /** Last time any frame arrived for this agent. */
    lastSignalAt: Timestamp,
  }),
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * How much of this agent's work the provider exposes.
 * - `full`: live transcript
 * - `summary`: start, end and a result only
 * - `placeholder`: only the tool call that spawned it
 */
export const AgentFidelity = z.enum(["full", "summary", "placeholder"]);
export type AgentFidelity = z.infer<typeof AgentFidelity>;

export const AgentOrigin = z.enum([
  /** The thread's root agent, started by the user. */
  "root",
  /** Spawned by a provider's own subagent tool. */
  "provider_subagent",
  /** Spawned by ace orchestration (fan-out, pipelines). */
  "ace",
]);
export type AgentOrigin = z.infer<typeof AgentOrigin>;

export const Agent = z.object({
  id: AgentId,
  threadId: ThreadId,
  parentId: AgentId.nullable(),
  origin: AgentOrigin,
  native: NativeRef,
  fidelity: AgentFidelity,
  /** Tool call in the parent's transcript that spawned this agent. */
  spawnedBy: ItemId.nullable().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string(),
  status: AgentStatus,
  /** Spawned to run in the background (the parent did not wait for it). */
  background: z.boolean().default(false),
  createdAt: Timestamp,
  endedAt: Timestamp.optional(),
});
export type Agent = z.infer<typeof Agent>;
