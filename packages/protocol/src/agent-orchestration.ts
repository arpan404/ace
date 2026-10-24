import { z } from "zod";
import { ModelFilter, CatalogModel, ModelInstanceStatus } from "./models.ts";
import { AccessMode } from "./permissions.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { WorktreeBase } from "./worktree-base.ts";

/** Paths are selected from Git's registered worktrees, never arbitrary execution roots. */
export const AgentWorkspace = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project") }),
  z.strictObject({ kind: z.literal("new_worktree"), base: WorktreeBase }),
  z.strictObject({ kind: z.literal("existing_worktree"), path: z.string().min(1).max(4096) }),
]);
export type AgentWorkspace = z.infer<typeof AgentWorkspace>;
export const AgentCatalogInput = ModelFilter.extend({
  offset: z.number().int().min(0).max(40960).default(0),
  limit: z.number().int().min(1).max(20).default(10),
  /** A model name as a person writes it ("opus 5.5"); the page holds the nearest models. */
  query: z.string().min(1).max(256).optional(),
});
const { raw: _raw, ...catalogModelShape } = CatalogModel.shape;
export const AgentCatalogModel = z.object(catalogModelShape).extend({
  /** With a query: every account that serves this model (`instance` is the first). */
  accounts: z.array(z.string().min(1).max(256)).max(64).optional(),
});
/** Native permission selectors stay in ace: an agent chooses by `allowedAccessModes`. */
export const AgentCatalogInstance = ModelInstanceStatus.omit({
  sources: true,
  permissionModes: true,
  accessModes: true,
}).extend({
  installed: z.boolean(),
  auth: z.enum(["logged_in", "logged_out", "unknown"]),
  accountLabel: z.string().max(256).optional(),
  availability: z.string().max(64).optional(),
  launchOptions: z.array(z.enum(["effort", "serviceTier"])).max(2),
  /** The access modes a delegated child may take on this instance: offered and within the caller's. */
  allowedAccessModes: z.array(AccessMode).max(4),
});
export const AgentCatalogPage = z.object({
  models: z.array(AgentCatalogModel).max(20),
  instances: z.array(AgentCatalogInstance).max(64),
  nextOffset: z.number().int().nonnegative().optional(),
  /** Accounts left out because their details would not fit one page; never set in practice. */
  instancesOmitted: z.number().int().positive().optional(),
  caller: z.object({ threadId: ThreadId, access: AccessMode.nullable() }),
});
export type AgentCatalogPage = z.infer<typeof AgentCatalogPage>;
export const AgentTaskState = z.enum([
  "working",
  "waiting_on_human",
  "waiting_on_children",
  "result_available",
  "failed",
  "cancelled",
]);
export const AgentTaskView = z.object({
  threadId: ThreadId,
  state: AgentTaskState,
  generation: z.number().int().nonnegative(),
});
export type AgentTaskView = z.infer<typeof AgentTaskView>;
export const ThreadListInput = z.strictObject({
  workspaceId: WorkspaceId.optional(),
  query: z.string().max(256).default(""),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
