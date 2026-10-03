import { AcpIdentity } from "./agent-registry.ts";
import { z } from "zod";

export const ProviderKind = z.enum([
  "claude",
  "codex",
  "opencode",
  "cursor",
  "antigravity",
  "acp",
  "pi",
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * Where an entity came from on the provider side. `nativeId` is the
 * provider's own id (Codex thread id, OpenCode session id, Claude task id…),
 * kept so adapters can route commands and so imports can be de-duplicated.
 */
export const NativeRef = z.object({
  provider: ProviderKind,
  ...AcpIdentity.partial().shape,
  nativeId: z.string().optional(),
  /** Hierarchical name when the provider has one (Codex `agent_path`, e.g. `/root/explorer`). */
  path: z.string().optional(),
  /** Native history lineage, separate from agent ancestry and workspace cloning. */
  forkedFromNativeId: z.string().min(1).max(1024).optional(),
  /** Other native ids that refer to the same entity (e.g. a resumed subagent's new session id). */
  aliases: z.array(z.string()).optional(),
});
export type NativeRef = z.infer<typeof NativeRef>;

/**
 * The provider's original payload, stored verbatim. Never interpreted by
 * clients except for debugging views; adapters can re-derive from it.
 */
export const InlineRawPayload = z.object({
  /** Native type or method name, e.g. `commandExecution`, `tool_use`, `session/update`. */
  type: z.string(),
  /** Native tool name when the provider sends one (`Bash`, `apply_patch`, `bash`…). */
  name: z.string().optional(),
  data: z.unknown(),
});
export const RawPayload = z.union([
  InlineRawPayload,
  z.object({
    type: z.string(),
    name: z.string().optional(),
    blobRef: z.string().min(1),
    size: z.number().int().nonnegative(),
    preview: z
      .string()
      .refine((text) => new TextEncoder().encode(text).length <= 2048)
      .meta({ "x-ace-constraint": "UTF-8 encoding must be at most 2048 bytes." }),
  }),
]);
export type RawPayload = z.infer<typeof RawPayload>;

/**
 * What an adapter can do. Clients read these to decide which controls to
 * show, instead of checking provider names.
 */
export const Capabilities = z.object({
  /** Omitted by older backends. Clients must retain their existing control policy. */
  approvals: z.enum(["interactive", "sandbox-only", "none"]).optional(),
  steeringMode: z.enum(["native", "interrupt-restart", "queue"]).optional(),
  forkMode: z.enum(["native", "context-handoff", "none"]).optional(),
  childControls: z.enum(["native", "read-only"]).optional(),
  childFidelity: z.enum(["full", "summary", "placeholder"]).optional(),
  /** Inject input into a running turn. When false, ace queues it client-side. */
  steer: z.boolean(),
  /** Interrupting a parent also stops its children. */
  interruptCascades: z.boolean(),
  resume: z.boolean(),
  fork: z.boolean(),
  /** Subagent transcripts are visible live. */
  subagentTranscripts: z.boolean(),
  /** Background tasks can be listed and stopped individually. */
  backgroundTaskControl: z.boolean(),
  /**
   * How much the provider tells us about work that outlives a turn.
   * `full`: start and end events; `partial`: start only, or end only;
   * `none`: invisible (ace must use a side channel or show a warning).
   */
  backgroundVisibility: z.enum(["full", "partial", "none"]),
  planMode: z.boolean(),
  tokenUsage: z.boolean(),
  imageInput: z.boolean(),
  /** File changes can be rewound by the provider itself. */
  rewindFiles: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;
