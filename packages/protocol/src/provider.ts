import { PermissionCapabilities } from "./permissions.ts";
import { AcpIdentity } from "./agent-registry.ts";
import { z } from "zod";

import { ProviderKind } from "./provider-data.ts";
export { ProviderKind, InlineRawPayload, RawPayload } from "./provider-data.ts";

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
 * What an adapter can do. Clients read these to decide which controls to
 * show, instead of checking provider names.
 */
export const Capabilities = z.object({
  permissions: PermissionCapabilities.optional(),
  /** Omitted by older backends. Clients must retain their existing control policy. */
  approvals: z.enum(["interactive", "sandbox-only", "none"]).optional(),
  steeringMode: z.enum(["native", "interrupt-restart", "queue"]).optional(),
  forkMode: z.enum(["native", "context-handoff", "none"]).optional(),
  childControls: z.enum(["native", "read-only"]).optional(),
  childFidelity: z.enum(["full", "summary", "placeholder"]).optional(),
  /** Inject input into a running turn. When false, ace queues it client-side. */
  steer: z.boolean(),
  /** Implemented launch selectors, empty when absent. */
  launchOptions: z
    .array(z.enum(["effort", "serviceTier"]))
    .max(2)
    .optional(),
  /** Interrupting a parent also stops its children. */
  interruptCascades: z.boolean(),
  resume: z.boolean(),
  fork: z.boolean(),
  /** Exact inclusive boundaries accepted by SessionContext.fork. */
  /** Adapter parses and applies SessionContext.options and live configure options. */
  /** Native session references on subagents can be used as independent fork sources. */
  forkSubagents: z.boolean().optional(),
  sessionOptions: z.boolean().optional(),
  forkPoints: z
    .array(z.enum(["turn", "item", "end"]))
    .max(2)
    .optional(),
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
