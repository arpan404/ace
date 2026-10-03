import { z } from "zod";
import { InteractionId } from "./ids.ts";

export const PermissionMode = z.enum(["read-only", "ask", "auto-review", "full-access"]);
export type PermissionMode = z.infer<typeof PermissionMode>;
/** Exact provider input, not a display title or a permission glob. */
export const ApprovalTarget = z.object({
  tool: z.string().min(1).max(256),
  command: z.string().max(32768).optional(),
  cwd: z.string().max(4096).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(128).optional(),
  access: z.enum(["read", "write", "execute", "unknown"]),
  input: z.unknown().optional(),
});
export type ApprovalTarget = z.infer<typeof ApprovalTarget>;
/** Coverage of action classes, not a promise that every action is reviewed by ace. */
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
  modes: z.array(PermissionMode).max(4),
  /** Native feature availability; this does not mean ace enables it. */
  nativeAutoReview: z.boolean(),
  /** Native approval requests can be answered through ace before execution. */
  toolGate: z.boolean(),
  /** Missing entries mean unknown coverage. Native full access has no guarantee. */
  guarantees: z.array(PermissionGuarantee).max(4).optional(),
});
export type PermissionCapabilities = z.infer<typeof PermissionCapabilities>;
export const PermissionState = z.object({
  override: PermissionMode.nullable(),
  effective: PermissionMode,
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
