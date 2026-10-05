import { AgentStatus } from "./agent-status.ts";
export { AgentActivity, BlockedReason, AgentError, AgentStatus } from "./agent-status.ts";
import { ThreadLineage } from "./thread-transitions.ts";
import { z } from "zod";
import { AgentId, ItemId, ThreadId, Timestamp } from "./ids.ts";
import { NativeRef } from "./provider.ts";

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
  /** Independent ace child thread; this agent is its summary in the parent tree. */
  childThreadId: ThreadId.optional(),
  parentId: AgentId.nullable(),
  origin: AgentOrigin,
  lineage: ThreadLineage.optional(),
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
