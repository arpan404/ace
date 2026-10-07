import { z } from "zod";
import { InteractionId } from "./ids.ts";

/** Native provider selector, or serialized native options when the harness has no mode enum. */
export const PermissionMode = z.string().min(1).max(4096);
/** Read historical audits; these values are no longer provider policies. */
export const LegacyPermissionMode = z.enum(["read-only", "ask", "auto-review", "full-access"]);
export type LegacyPermissionMode = z.infer<typeof LegacyPermissionMode>;
export const NativePermissionMode = z.object({
  id: PermissionMode,
  label: z.string().min(1).max(256),
  description: z.string().max(2048),
  risk: z.enum(["low", "medium", "high"]),
  default: z.boolean().optional(),
});
export type NativePermissionMode = z.infer<typeof NativePermissionMode>;
export type PermissionMode = z.infer<typeof PermissionMode>;
/** Exact provider input, not a display title or a permission glob. */
export const ApprovalTarget = z.object({
  tool: z.string().min(1).max(256),
  origin: z.literal("ace").optional(),
  description: z.string().max(2048).optional(),
  riskClass: z.enum(["read-only", "thread-write", "agent-execution", "external-effect"]).optional(),
  command: z.string().max(32768).optional(),
  cwd: z.string().max(4096).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(128).optional(),
  access: z.enum(["read", "write", "execute", "unknown"]),
  input: z.unknown().optional(),
});
export type ApprovalTarget = z.infer<typeof ApprovalTarget>;
/** Deprecated historical metadata; native adapters no longer report ace coverage guarantees. */
export const PermissionGuarantee = z.object({
  mode: PermissionMode,
  level: z.enum(["tool-gate", "sandbox", "tool-selection", "permission-requests"]),
  gates: z.object({
    writes: z.boolean(),
    network: z.boolean(),
    protectedReads: z.boolean(),
    shell: z.boolean(),
  }),
  limitations: z.array(z.string().min(1).max(2048)).max(32),
});
export type PermissionGuarantee = z.infer<typeof PermissionGuarantee>;
export const PermissionCapabilities = z.object({
  /** Deprecated compatibility view; use permissionModes. */
  modes: z.array(PermissionMode).max(256),
  permissionModes: z.array(NativePermissionMode).max(256).optional(),
  /** Native feature availability; this does not mean ace enables it. */
  nativeAutoReview: z.boolean(),
  /** Native approval requests can be answered through ace before execution. */
  toolGate: z.boolean(),
  /** Deprecated; retained only to decode old stored capabilities. */
  guarantees: z.array(PermissionGuarantee).max(4).optional(),
});
export type PermissionCapabilities = z.infer<typeof PermissionCapabilities>;
export const PermissionState = z.object({
  override: PermissionMode.nullable(),
  effective: PermissionMode.nullable(),
  pending: z.boolean(),
});
export type PermissionState = z.infer<typeof PermissionState>;
export const PermissionReview = z.object({
  interactionId: InteractionId,
  mode: PermissionMode,
  decision: z.enum(["approve", "deny", "escalate"]),
  reason: z.string().min(1).max(2048),
  reviewer: z.literal("ace-risk-policy"),
  target: ApprovalTarget.optional(),
});
export type PermissionReview = z.infer<typeof PermissionReview>;
