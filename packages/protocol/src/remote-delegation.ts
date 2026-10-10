import {
  RemoteArtifactManifest,
  RemoteContextManifest,
  RemoteContextOperation,
  RemoteRelayTarget,
} from "./remote-context.ts";
import { ContextResult } from "./context.ts";
import { z } from "zod";
import { RemoteDelegationRequest, AgentSelection } from "./agent-control.ts";
import { HostId, WorkspaceId, ThreadId, AgentId } from "./ids.ts";
import { NativePermissionMode } from "./permissions.ts";

const key = z.string().min(1).max(128);
export const RemoteAgentHost = z.strictObject({
  hostId: HostId,
  name: z.string().min(1).max(256),
  projects: z
    .array(z.strictObject({ workspaceId: WorkspaceId, name: z.string().max(256) }))
    .max(100),
  agents: z
    .array(
      AgentSelection.extend({
        model: z.string().min(1).max(256),
        permissionModes: z.array(NativePermissionMode).max(256),
      }),
    )
    .max(100),
});
export type RemoteAgentHost = z.infer<typeof RemoteAgentHost>;
export const RemoteTaskPhase = z.enum([
  "queued",
  "running",
  "waiting",
  "unavailable",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
export const RemoteTaskUsage = z.strictObject({
  tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cost: z.number().nonnegative().finite(),
});
export type RemoteTaskUsage = z.infer<typeof RemoteTaskUsage>;
export const RemoteTask = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  context: RemoteContextManifest.optional(),
  artifacts: RemoteArtifactManifest.optional(),
  sourceHostId: HostId,
  rootThreadId: ThreadId,
  parentProvider: AgentSelection.shape.provider,
  parentPermissionMode: z.string().max(4096).nullable(),
  parentPermissionOverride: z.string().max(4096).nullable().default(null),
  parentThreadId: ThreadId,
  parentAgentId: AgentId,
  threadId: ThreadId,
  request: RemoteDelegationRequest,
  permissionMode: z.string().min(1).max(4096),
  usage: RemoteTaskUsage.default({ tokens: 0, cost: 0 }),
  phase: RemoteTaskPhase,
  dispatched: z.boolean(),
  result: z.string().max(4096).optional(),
  error: z.string().max(256).optional(),
  delivered: z.boolean(),
  createdAt: z.number().nonnegative(),
});
export type RemoteTask = z.infer<typeof RemoteTask>;
export const RemoteTaskReport = z.strictObject({
  usage: RemoteTaskUsage.optional(),
  taskId: key,
  artifacts: RemoteArtifactManifest.optional(),
  phase: RemoteTaskPhase.exclude(["queued"]),
  result: z.string().max(4096).optional(),
  error: z.string().max(256).optional(),
});
export type RemoteTaskReport = z.infer<typeof RemoteTaskReport>;
export const RemoteDelegationClient = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("delegation.remote.transport"), requestId: key }),
  z.strictObject({
    type: z.literal("delegation.remote.output"),
    requestId: key,
    taskId: z.string().regex(/^[a-f0-9]{64}$/),
    operation: RemoteContextOperation.options[0],
  }),
  z.strictObject({
    type: z.literal("delegation.broker.return"),
    requestId: key,
    lease: key,
    artifacts: RemoteArtifactManifest,
    operation: z.discriminatedUnion("op", [
      RemoteContextOperation.options[1],
      RemoteContextOperation.options[2],
      RemoteContextOperation.options[3],
      RemoteContextOperation.options[4],
    ]),
  }),
  z.strictObject({
    type: z.literal("delegation.remote.context"),
    requestId: key,
    task: RemoteTask,
    operation: RemoteContextOperation,
  }),
  z.strictObject({ type: z.literal("delegation.remote.start"), requestId: key, task: RemoteTask }),
  z.strictObject({
    type: z.literal("delegation.remote.status"),
    requestId: key,
    taskId: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    type: z.literal("delegation.remote.cancel"),
    requestId: key,
    taskId: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    type: z.literal("delegation.broker.register"),
    requestId: key,
    hosts: z.array(RemoteAgentHost).max(32),
  }),
  z.strictObject({ type: z.literal("delegation.broker.poll"), requestId: key, lease: key }),
  z.strictObject({
    type: z.literal("delegation.broker.report"),
    requestId: key,
    lease: key,
    report: RemoteTaskReport,
  }),
]);
export const RemoteDelegationResult = z.strictObject({
  type: z.literal("delegation.broker.result"),
  requestId: key,
  ok: z.boolean(),
  error: z.enum(["forbidden", "busy", "not_ready", "invalid", "not_found"]).optional(),
  context: ContextResult.shape.result.optional(),
  relay: RemoteRelayTarget.optional(),
  artifacts: RemoteArtifactManifest.optional(),
  usage: RemoteTaskUsage.optional(),
  phase: RemoteTaskPhase.optional(),
  result: z.string().max(4096).optional(),
  truncated: z.boolean().optional(),
  lease: key.optional(),
  tasks: z.array(RemoteTask).max(64).optional(),
});
export type RemoteDelegationResult = z.infer<typeof RemoteDelegationResult>;
