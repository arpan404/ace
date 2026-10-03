import { z } from "zod";
import { RawPayload } from "@ace/protocol";
import { ContentPart } from "@ace/protocol";
import { CursorSdkAuth } from "@ace/protocol/accounts";

export const sdkVersion = "1.0.35";
const identity = z.string().min(1).max(512);
export const Limits = z.strictObject({
  maxWorkers: z.number().int().positive().max(64).default(8),
  maxFrameBytes: z.number().int().min(4096).max(1_048_576).default(1_048_576),
  maxPendingBytes: z.number().int().min(4096).max(8_388_608).default(2_097_152),
  maxCallbacks: z.number().int().positive().max(256).default(32),
  maxIdentities: z.number().int().positive().max(8192).default(2048),
  maxInputBytes: z.number().int().positive().max(524288).default(262144),
  maxCheckpointBytes: z.number().int().positive().max(67_108_864).default(8_388_608),
  historyPageSize: z.number().int().positive().max(200).default(100),
  heapMb: z.number().int().min(64).max(1024).default(256),
  timeoutMs: z.number().int().positive().max(300000).default(30000),
  graceMs: z.number().int().nonnegative().max(30000).default(5000),
});
export type CursorLimits = z.infer<typeof Limits>;
export const Envelope = z
  .object({
    schemaVersion: z.literal(1),
    operationId: identity,
    commandId: identity.optional(),
    generation: identity,
    segment: z.number().int().nonnegative(),
    agentId: identity.optional(),
    runId: identity.optional(),
    kind: z.string().min(1).max(128),
    body: z.unknown(),
    raw: RawPayload.optional(),
    boundaryOffset: z.number().int().positive().max(10000000).optional(),
    observeOffset: identity.optional(),
    replayed: z.boolean().optional(),
    recordedAt: z.number().finite().nonnegative().optional(),
  })
  .passthrough();
export type CursorEnvelope = z.infer<typeof Envelope>;
export const Open = z.strictObject({
  cwd: z.string().min(1).max(4096),
  threadId: identity,
  generation: identity,
  model: identity.optional(),
  nativeSessionId: identity.optional(),
  afterFrameOffset: z.number().int().nonnegative().max(10000000).default(0),
  policy: z.enum(["restricted", "full-access"]),
  limits: Limits,
  // Trusted composition must establish classifier availability before setting this.
  autoReviewAvailable: z.boolean().default(false),
  mcp: z
    .strictObject({ url: z.string().max(4096), bearer: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional(),
});
export type OpenOptions = z.infer<typeof Open>;
export const Send = z.strictObject({
  operationId: identity,
  commandId: identity.optional(),
  segment: z.number().int().nonnegative(),
  input: z.array(ContentPart).max(64),
});
export type SendOptions = z.infer<typeof Send>;
export const SafeAuth = CursorSdkAuth;
export type CursorAuthStatus = z.infer<typeof SafeAuth>;
export const NativeMessage = z
  .object({ type: z.string(), agent_id: identity.optional(), run_id: identity.optional() })
  .passthrough();
export const Data = z.record(z.string(), z.unknown());
export function object(value: unknown): Record<string, unknown> {
  const result = Data.safeParse(value);
  return result.success ? result.data : {};
}
export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function nativeIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.length || value.length > 512) throw new Error("SDK native identity exceeds budget");
  return value;
}
