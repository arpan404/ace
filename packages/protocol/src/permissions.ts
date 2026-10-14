import { z } from "zod";
import { InteractionId } from "./ids.ts";
import { ProviderKind } from "./provider-data.ts";
import { AcpIdentity } from "./agent-registry.ts";

/** Opaque policy names only have meaning within this execution identity. */
export const PermissionPolicyIdentity = z
  .object({
    provider: ProviderKind,
    backend: z.enum(["acp", "cursor-sdk"]).optional(),
    ...AcpIdentity.partial().shape,
  })
  .refine((identity) => identity.provider !== "acp" || AcpIdentity.safeParse(identity).success)
  .meta({ "x-ace-constraint": "ACP policies require acpAgentId, installationId and instanceId." });
export type PermissionPolicyIdentity = z.infer<typeof PermissionPolicyIdentity>;

/** Native provider selector, or serialized native options when the harness has no mode enum. */
export const PermissionMode = z.string().min(1).max(4096);
export type PermissionMode = z.infer<typeof PermissionMode>;
/**
 * ace's four access modes, least to most capable (ADR 0075). Each provider maps a mode to exact
 * native settings; a provider that can't express a mode natively doesn't offer it.
 */
export const AccessMode = z.enum(["read-only", "ask", "auto-review", "full-access"]);
export type AccessMode = z.infer<typeof AccessMode>;
/** A mode an instance offers, with the exact native selector ace sends for it. */
export const AccessModeOffer = z.object({ mode: AccessMode, native: PermissionMode });
export type AccessModeOffer = z.infer<typeof AccessModeOffer>;
/** A delegated child's access: its parent's, or one of the four. */
export const AccessRequest = z.union([z.literal("inherit"), AccessMode]);
export type AccessRequest = z.infer<typeof AccessRequest>;
export const NativePermissionMode = z.object({
  id: PermissionMode,
  label: z.string().min(1).max(256),
  description: z.string().max(2048),
  risk: z.enum(["low", "medium", "high"]),
  /** Verified presentation meaning only; never used for permission enforcement. */
  presentation: z.literal("full-access").optional(),
  default: z.boolean().optional(),
});
export type NativePermissionMode = z.infer<typeof NativePermissionMode>;
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
  /** Native selectors the instance accepts; ace modes map onto these. */
  modes: z.array(PermissionMode).max(256),
  /** Native vocabulary, offered only under Settings → Providers → Advanced. */
  permissionModes: z.array(NativePermissionMode).max(256).optional(),
  /** Native feature availability; this does not mean ace enables it. */
  nativeAutoReview: z.boolean(),
  /** Native approval requests can be answered through ace before execution. */
  toolGate: z.boolean(),
  /** Deprecated; retained only to decode old stored capabilities. */
  guarantees: z.array(PermissionGuarantee).max(4).optional(),
});
export type PermissionCapabilities = z.infer<typeof PermissionCapabilities>;
/**
 * A thread's access. `override` is the explicit choice for the thread (null follows the
 * defaults) and `effective` the mode the provider runs. `custom` names the native selector
 * when an Advanced provider override runs instead of an ace mode. Values recorded before the
 * four modes are mapped once when a daemon loads them (ADR 0078).
 */
export const PermissionState = z.object({
  override: AccessMode.nullable(),
  effective: AccessMode.nullable(),
  custom: PermissionMode.optional(),
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
