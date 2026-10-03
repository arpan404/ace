import { WorkspaceFilesChanged } from "./files.ts";
import { z } from "zod";
import { UsageMetadata } from "./usage.ts";
import { Agent, AgentFidelity, AgentOrigin, AgentStatus } from "./agent.ts";
import { BackgroundTask } from "./background.ts";
import {
  AgentId,
  BackgroundTaskId,
  DeviceId,
  EventId,
  InteractionId,
  ItemId,
  RunId,
  ThreadId,
  Timestamp,
} from "./ids.ts";
import { Interaction, InteractionResolution, InteractionState } from "./interactions.ts";
import { Item } from "./items.ts";
import { NativeRef } from "./provider.ts";
import { Run, RunTrigger, Thread, ThreadStatus } from "./thread.ts";

export const UsageUpdated = UsageMetadata.safeExtend({
  type: z.literal("usage.updated"),
  agentId: AgentId,
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  contextWindow: z.number().int().positive().optional(),
  costUsd: z.number().nonnegative().optional(),
}).meta(UsageMetadata.meta() ?? {});
export type UsageUpdated = z.infer<typeof UsageUpdated>;

export const EventPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread.created"), thread: Thread }),
  z.object({
    type: z.literal("thread.updated"),
    backend: Thread.shape.backend,
    capabilities: Thread.shape.capabilities,
    title: z.string().optional(),
    status: ThreadStatus.optional(),
    archivedAt: Timestamp.nullable().optional(),
  }),
  z.object({ type: z.literal("agent.created"), agent: Agent }),
  z.object({ type: z.literal("agent.status"), agentId: AgentId, status: AgentStatus }),
  z.object({
    type: z.literal("agent.updated"),
    agentId: AgentId,
    /** Placeholder agents are completed and re-parented after native linkage arrives. */
    parentId: AgentId.nullable().optional(),
    origin: AgentOrigin.optional(),
    fidelity: AgentFidelity.optional(),
    native: NativeRef.optional(),
    cwd: z.string().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    model: z.string().optional(),
    /** Linked late, or cleared when authoritative parentage invalidates the spawning owner. */
    spawnedBy: ItemId.nullable().optional(),
    background: z.boolean().optional(),
    endedAt: Timestamp.optional(),
  }),
  z.object({ type: z.literal("run.started"), run: Run }),
  z.object({
    type: z.literal("run.ended"),
    runId: RunId,
    state: z.enum(["completed", "interrupted", "failed"]),
    /** Corrected trigger, when the provider only reveals it at the end. */
    trigger: RunTrigger.optional(),
    endedAt: Timestamp,
  }),
  /**
   * Items may arrive after their run ended (background shells and subagents
   * report under the finished turn). Consumers must not assume run order.
   */
  z.object({ type: z.literal("item.created"), item: Item }),
  /** Streaming append. Clients concatenate; the next `item.updated` is authoritative. */
  z.object({
    type: z.literal("item.delta"),
    itemId: ItemId,
    agentId: AgentId,
    field: z.enum(["text", "reasoning", "output"]),
    append: z.string(),
  }),
  z.object({ type: z.literal("item.updated"), item: Item }),
  z.object({ type: z.literal("item.deleted"), itemId: ItemId }),
  z.object({ type: z.literal("interaction.opened"), interaction: Interaction }),
  z.object({
    type: z.literal("interaction.closed"),
    interactionId: InteractionId,
    state: InteractionState.exclude(["pending"]),
    resolution: InteractionResolution.optional(),
    resolvedBy: DeviceId.optional(),
    closedAt: Timestamp,
  }),
  z.object({ type: z.literal("background_task.started"), task: BackgroundTask }),
  z.object({
    type: z.literal("background_task.updated"),
    taskId: BackgroundTaskId,
    status: BackgroundTask.shape.status,
    endedAt: Timestamp.optional(),
  }),
  UsageUpdated,
  WorkspaceFilesChanged,
]);
export type EventPayload = z.infer<typeof EventPayload>;
export type EventType = EventPayload["type"];

/**
 * One entry in the host's append-only log. `seq` is gap-free and increasing
 * per host; clients resume a subscription with "everything after seq N".
 */
export const Event = z.object({
  seq: z.number().int().nonnegative(),
  id: EventId,
  at: Timestamp,
  threadId: ThreadId,
  payload: EventPayload,
});
export type Event = z.infer<typeof Event>;
