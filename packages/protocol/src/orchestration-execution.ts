import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { ThreadStatus } from "./thread.ts";
import {
  LaneId,
  LaneSpec,
  OrchestrationArtifact,
  OrchestrationCreate,
  OrchestrationId,
  OrchestrationUsage,
} from "./orchestration.ts";
const attempt = z.number().int().min(1).max(10);
const lane = { laneId: LaneId, attempt };
export const OrchestrationEffect = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    ...lane,
    prompt: z.string().max(33024),
    spec: LaneSpec,
    input: OrchestrationArtifact.optional(),
  }),
  z.object({ type: z.literal("check"), ...lane, artifact: OrchestrationArtifact }),
  z.object({ type: z.literal("cancel"), ...lane }),
  z.object({ type: z.literal("merge"), ...lane, checkpoint: z.string().max(512) }),
]);
export type OrchestrationEffect = z.infer<typeof OrchestrationEffect>;
export const OrchestrationIntent = z.object({ id: OrchestrationId, effect: OrchestrationEffect });
export type OrchestrationIntent = z.infer<typeof OrchestrationIntent>;
export const OrchestrationFact = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bound"),
    ...lane,
    threadId: ThreadId,
    worktree: z.string().min(1).max(512),
  }),
  z.object({ type: z.literal("thread"), ...lane, status: ThreadStatus }),
  z.object({ type: z.literal("artifact"), ...lane, artifact: OrchestrationArtifact }),
  z.object({
    type: z.literal("checked"),
    ...lane,
    intentId: OrchestrationId,
    commandPassed: z.boolean(),
    reviewPassed: z.boolean().optional(),
  }),
  z.object({ type: z.literal("usage"), ...lane, usage: OrchestrationUsage }),
  z.object({ type: z.literal("stopped"), ...lane }),
  z.object({
    type: z.literal("execution.failed"),
    ...lane,
    intentId: OrchestrationId,
    operation: z.enum(["start", "check", "merge"]),
    error: z.string().max(8192),
  }),
  z.object({
    type: z.literal("spawn"),
    parentId: LaneId,
    attempt,
    requestId: OrchestrationId,
    spec: LaneSpec,
    prompt: z.string().min(1).max(32768),
  }),
  z.object({ type: z.literal("pick"), laneId: LaneId, merge: z.boolean() }),
  z.object({
    type: z.literal("merged"),
    ...lane,
    intentId: OrchestrationId,
    safetyCheckpoint: z.string().min(1).max(512),
  }),
  z.object({ type: z.literal("ack"), intentId: OrchestrationId }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("tick") }),
]);
export type OrchestrationFact = z.infer<typeof OrchestrationFact>;
export const OrchestrationCreateCommand = z.object({
  type: z.literal("orchestration.create"),
  input: OrchestrationCreate,
});
export const OrchestrationCancelCommand = z.object({
  type: z.literal("orchestration.cancel"),
  orchestrationId: OrchestrationId,
});
export const OrchestrationPickCommand = z.object({
  type: z.literal("orchestration.pick"),
  orchestrationId: OrchestrationId,
  laneId: LaneId,
  merge: z.boolean().default(false),
});
