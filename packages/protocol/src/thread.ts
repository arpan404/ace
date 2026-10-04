import { PermissionState } from "./permissions.ts";
import { ThreadClientFields } from "./thread-client.ts";
import {
  ThreadLineage,
  ExecutionSelection,
  ThreadSwitch,
  ExecutionSource,
} from "./thread-transitions.ts";
import { AcpIdentity, AcpSessionSupport } from "./agent-registry.ts";
import { RunCheckpoints } from "./run-client.ts";
import { z } from "zod";
import { AgentId, RunId, ThreadId, Timestamp, WorkspaceId } from "./ids.ts";
import { ImportedProvenance } from "./history.ts";
import { ProviderKind, Capabilities } from "./provider.ts";

/** What started a run. Agents can start runs without anyone asking. */
export const RunTrigger = z.enum([
  "user",
  "restart",
  "limit_resume",
  /** First run of a newly spawned subagent. */
  "spawn",
  /** A parent agent sent this agent more work (follow-up, message). */
  "parent_agent",
  "background_completion",
  "subagent_result",
  "goal",
  "queue",
  "schedule",
  "unknown",
]);
export type RunTrigger = z.infer<typeof RunTrigger>;

/** One turn of one agent: from its first output to the provider's turn end. */
export const Run = z.object({
  id: RunId,
  threadId: ThreadId,
  agentId: AgentId,
  /**
   * Some providers only reveal why a run started when it ends (Claude puts
   * the origin on the final result). Adapters start with `unknown` and
   * correct it in `run.ended`.
   */
  trigger: RunTrigger,
  /** Provider's turn id, when it has one. */
  nativeId: z.string().optional(),
  /** Stable root-turn number; subagent runs do not consume it. */
  ordinal: z.number().int().positive().optional(),
  checkpoints: RunCheckpoints.optional(),
  executionSource: ExecutionSource.optional(),
  state: z.enum(["active", "completed", "interrupted", "failed"]),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
});
export type Run = z.infer<typeof Run>;

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

export const ThreadProviderMetadata = AcpIdentity.partial().extend({
  effectiveCapabilities: Capabilities.optional(),
  acpSupport: AcpSessionSupport.optional(),
});
export type ThreadProviderMetadata = z.infer<typeof ThreadProviderMetadata>;

export const Thread = z.object({
  ...ThreadClientFields.shape,
  id: ThreadId,
  workspaceId: WorkspaceId,
  title: z.string(),
  titleSource: z.enum(["provisional", "provider", "person", "agent"]).optional(),
  provider: ProviderKind,
  backend: z.enum(["acp", "cursor-sdk"]).optional(),
  capabilities: Capabilities.optional(),
  permission: PermissionState.optional(),
  handoff: z
    .object({
      sourceThreadId: ThreadId,
      truncated: z.boolean(),
      bytes: z.number().int().nonnegative(),
    })
    .optional(),
  ...ThreadProviderMetadata.shape,
  rootAgentId: AgentId.optional(),
  status: ThreadStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.optional(),
  imported: ImportedProvenance.optional(),
  lineage: ThreadLineage.optional(),
  execution: ExecutionSelection.optional(),
  switch: ThreadSwitch.optional(),
});
export type Thread = z.infer<typeof Thread>;
