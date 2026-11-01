import { AgentStatus } from "./agent-status.ts";
export { AgentActivity, BlockedReason, AgentError, AgentStatus } from "./agent-status.ts";
import { ThreadLineage } from "./thread-transitions.ts";
import { z } from "zod";
import { AgentId, HostId, ItemId, ThreadId, Timestamp } from "./ids.ts";
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

/**
 * How this machine stands with a child on another machine (ADR 0052, "Stop and proof of life"):
 * - `lost`: its machine stopped reporting it past its lease. It is not running, waiting or done,
 *   and it no longer holds its parent; it resumes if it reports again.
 * - `unconfirmed`: stopped here after every cancel went out, but its machine never confirmed it
 *   ended. Final: a later report records its real end and never makes it live again.
 * Decoded leniently: a value this build doesn't know reads as no contact problem.
 */
export const RemoteContact = z.enum(["lost", "unconfirmed"]);
export type RemoteContact = z.infer<typeof RemoteContact>;

/** The paired machine a delegated child runs on, when that is not this one (ADR 0078). */
export const AgentMachine = z.object({
  machine: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  /** That machine's host id when known, so a window paired with it opens the child there. */
  hostId: HostId.optional(),
  contact: RemoteContact.optional().catch(undefined),
});
export type AgentMachine = z.infer<typeof AgentMachine>;

export const Agent = z.object({
  id: AgentId,
  threadId: ThreadId,
  /** Independent ace child thread; this agent is its summary in the parent tree. */
  childThreadId: ThreadId.optional(),
  /**
   * Set when that child thread runs on another paired machine: it lives there, so this agent is
   * all this machine knows of it, with its status as that machine last reported (ADR 0108).
   */
  machine: AgentMachine.optional(),
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
