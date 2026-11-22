import { z } from "zod";
import { nativeRecord, type NativeRecord } from "@ace/provider-kit/record";
import { RawPayload } from "@ace/protocol";
import { ContentPart } from "@ace/protocol";
import { CursorSdkAuth } from "@ace/protocol/accounts";
import { CursorModelParams } from "@ace/provider-kit/cursor-selection";
import { cliRequirements } from "@ace/provider-kit/cli-requirements";

/** The oldest SDK ace admits; it ships with ace, and a newer resolved copy is admitted too. */
export const sdkVersion = cliRequirements["cursor-sdk"].minimum;
const identity = z.string().min(1).max(512);
export const Limits = z.strictObject({
  maxWorkers: z.number().int().positive().max(64).default(8),
  maxFrameBytes: z.number().int().min(4096).max(1_048_576).default(1_048_576),
  maxPendingBytes: z.number().int().min(4096).max(8_388_608).default(2_097_152),
  maxCallbacks: z.number().int().positive().max(256).default(32),
  maxIdentities: z.number().int().positive().max(8192).default(2048),
  maxInputBytes: z.number().int().positive().max(524288).default(262144),
  maxCheckpointBytes: z.number().int().positive().max(68_719_476_736).default(8_589_934_592),
  historyPageSize: z.number().int().positive().max(200).default(100),
  heapMb: z.number().int().min(64).max(8192).default(2048),
  timeoutMs: z.number().int().positive().max(300000).default(30000),
  sendTimeoutMs: z.number().int().positive().max(600000).default(300000),
  /** How long the host waits for ace to store one frame before fencing the turn. */
  ackTimeoutMs: z.number().int().positive().max(600000).default(300000),
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
    /** Every stored event of the run up to this sequence is in ace's frames (run-seams.ts). */
    eventSeq: z.number().int().nonnegative().max(100_000_000).optional(),
    /** The SDK's offset of event `eventSeq`: recovery reads on from there. */
    eventOffset: z.string().min(1).max(512).optional(),
    /** Updates framed so far whose events the SDK has not stored yet (run-seams.ts). */
    pendingEvents: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(64)
      .optional(),
  })
  .passthrough();
export type CursorEnvelope = z.infer<typeof Envelope>;
export const Open = z.strictObject({
  cwd: z.string().min(1).max(4096),
  threadId: identity,
  generation: identity,
  model: identity.optional(),
  modelParams: CursorModelParams.optional(),
  nativeSessionId: identity.optional(),
  /** What the daemon's record of the open turn lacks, read back from the SDK store at open. */
  recover: z
    .strictObject({
      /** Runs the open turn started and the daemon never saw end, with how far it saw them. */
      runs: z
        .array(
          z.strictObject({
            runId: identity,
            /** The last stored event ace's record covers. */
            through: z.number().int().nonnegative(),
            /** The SDK's offset of event `through`, when ace has it. */
            afterOffset: z.string().min(1).max(512).optional(),
            /** Updates ace committed whose events come after it, oldest first. */
            pending: z
              .array(z.string().regex(/^[a-f0-9]{64}$/))
              .max(64)
              .optional(),
            /** Known only from an earlier build's frames: its content can't be lined up. */
            legacy: z.boolean().optional(),
          }),
        )
        .max(64)
        .default([]),
      /** A send the host attempted with no admission evidence yet; `at` is its wall clock. */
      attempt: z
        .strictObject({
          operationId: identity,
          commandId: identity.optional(),
          segment: z.number().int().nonnegative(),
          at: z.number().finite().nonnegative(),
          /** The host frames the run's id before the SDK creates it: no id means no run. */
          runFramed: z.literal(true).optional(),
          /** The id of the run the SDK was about to create, when ace got it. */
          runId: identity.optional(),
        })
        .optional(),
    })
    .default({ runs: [] }),
  /** The thread's checkpoint generation (ADR 0211); absent is the thread's first store. */
  checkpointGeneration: z.number().int().nonnegative().max(1024).optional(),
  policy: z.enum(["restricted", "full-access"]).optional(),
  permissionMode: z.string().min(1).max(4096).optional(),
  limits: Limits,
  readOnly: z.boolean().default(false),
  // Legacy sandbox hint for injected hosts; production uses SDK executor admission.
  autoReviewAvailable: z.boolean().default(false),
  mcp: z
    .strictObject({ url: z.string().max(4096), bearer: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional(),
  /** This session's ace guidance for the rule; without it the rule carries the static guidance. */
  instructions: z.string().min(1).max(16384).optional(),
});
export type OpenOptions = z.infer<typeof Open>;
export const Configure = Open.pick({ model: true, modelParams: true }).required({ model: true });
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
export function object(value: unknown): NativeRecord {
  return nativeRecord(value);
}
export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function nativeIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.length || value.length > 512) throw new Error("SDK native identity exceeds budget");
  return value;
}
