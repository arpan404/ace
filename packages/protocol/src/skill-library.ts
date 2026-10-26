import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider-data.ts";

/** Opaque, stable for one canonical skill directory (derived from its resolved path). */
export const SkillId = z.string().regex(/^skl_[a-f0-9]{40}$/);
export type SkillId = z.infer<typeof SkillId>;
/** Names a new skill may take: the Agent Skills slug rule every agent accepts. */
export const SkillSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const SkillHash = z.string().regex(/^[a-f0-9]{64}$/);
export const SkillScope = z.enum(["project", "personal", "plugin", "builtin"]);
export type SkillScope = z.infer<typeof SkillScope>;
/** Agents with their own skill folders. ACP and Antigravity receive skills through ace. */
export const SkillAgent = ProviderKind.extract(["claude", "codex", "opencode", "cursor", "pi"]);
export type SkillAgent = z.infer<typeof SkillAgent>;

export const SkillPresence = z.object({
  provider: SkillAgent,
  /**
   * native: the canonical folder sits in a folder this agent reads.
   * link: a symlink in this agent's folder resolves to the canonical folder.
   * copy: this agent has its own separate folder with the same name.
   */
  via: z.enum(["native", "link", "copy"]),
  /** Display path of what this agent reads (home as ~, project-relative for project skills). */
  path: z.string().max(4096),
  /** False when `skills.setAgents` cannot remove it: canonical, copy or shared folders. */
  removable: z.boolean(),
  /** Whether this agent honours `manual` (Claude, Cursor and Pi do; Codex and OpenCode don't). */
  honoursManual: z.boolean(),
});
export type SkillPresence = z.infer<typeof SkillPresence>;

export const SkillSource = z.object({
  /** `skills` CLI lock entry: `owner/repo`, its clone URL and the SKILL.md path inside it. */
  source: z.string().max(512),
  url: z.string().max(4096),
  path: z.string().max(4096),
  /** Git tree SHA of the installed folder, as recorded by the lock file. */
  folderHash: z.string().max(64),
  updatedAt: z.string().max(64).optional(),
});
export type SkillSource = z.infer<typeof SkillSource>;

export const SkillEntry = z.object({
  id: SkillId,
  name: z.string().min(1).max(256),
  title: z.string().min(1).max(256).optional(),
  description: z.string().max(2048),
  scope: SkillScope,
  /** Canonical folder for display: `~/.agents/skills/x` or `.claude/skills/x` for project skills. */
  path: z.string().max(4096),
  agents: z.array(SkillPresence).max(16),
  /** Only runs when picked (`disable-model-invocation: true`). */
  manual: z.boolean(),
  argumentHint: z.string().max(1024).optional(),
  editable: z.boolean(),
  source: SkillSource.optional(),
  /** SHA-256 of SKILL.md. Edits and deletes must name it. */
  hash: SkillHash,
});
export type SkillEntry = z.infer<typeof SkillEntry>;

export const SkillUpdateFile = z.object({
  path: z.string().max(4096),
  change: z.enum(["added", "changed", "removed"]),
  /** Executable bit set, or a file type agents may run (anything that isn't Markdown or text). */
  flagged: z.boolean(),
});
export const SkillUpdateReview = z.object({
  id: z.string().min(1).max(128),
  skillId: SkillId,
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  folderHash: z.string().max(64),
  /** SKILL.md hash of the installed folder the review compared against; applyUpdate sends it back. */
  baseHash: SkillHash,
  files: z.array(SkillUpdateFile).max(512),
  before: z.string().max(262144),
  after: z.string().max(262144),
});
export type SkillUpdateReview = z.infer<typeof SkillUpdateReview>;

export const SkillUsage = z.object({
  id: SkillId,
  count: z.number().int().nonnegative(),
  last: z
    .object({ threadId: ThreadId, title: z.string().max(512), at: z.number().int() })
    .optional(),
});
export type SkillUsage = z.infer<typeof SkillUsage>;

const target = { id: SkillId, workspaceId: WorkspaceId.optional() };
const body = z.string().max(262144);
export const SkillOperation = z.discriminatedUnion("op", [
  /** Personal, plugin and builtin skills, plus the project's when a workspace is named. */
  z.object({
    op: z.literal("list"),
    workspaceId: WorkspaceId.optional(),
    subscribe: z.boolean().default(false),
  }),
  z.object({ op: z.literal("read"), ...target }),
  z.object({
    op: z.literal("create"),
    name: SkillSlug,
    description: z.string().min(1).max(1024),
    body,
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("personal") }),
      z.object({ kind: z.literal("project"), workspaceId: WorkspaceId }),
    ]),
    agents: z.array(SkillAgent).min(1).max(8),
    manual: z.boolean().default(false),
  }),
  z.object({
    op: z.literal("edit"),
    ...target,
    expectedHash: SkillHash,
    description: z.string().min(1).max(1024),
    body,
    manual: z.boolean(),
  }),
  z.object({ op: z.literal("setAgents"), ...target, agents: z.array(SkillAgent).max(8) }),
  z.object({ op: z.literal("delete"), ...target, expectedHash: SkillHash }),
  z.object({ op: z.literal("checkUpdate"), ...target }),
  z.object({ op: z.literal("prepareUpdate"), ...target }),
  z.object({
    op: z.literal("applyUpdate"),
    ...target,
    reviewId: SkillUpdateReview.shape.id,
    expectedHash: SkillHash,
  }),
  z.object({ op: z.literal("cancelUpdate"), reviewId: SkillUpdateReview.shape.id }),
  z.object({
    op: z.literal("usage"),
    workspaceId: WorkspaceId.optional(),
    ids: z.array(SkillId).max(1024),
  }),
]);
export type SkillOperation = z.infer<typeof SkillOperation>;

export const SkillErrorCode = z.enum([
  "unavailable",
  /** Another ace on this machine holds the skills lock; trying again shortly works. */
  "busy",
  "forbidden",
  "not_found",
  "conflict",
  "exists",
  "invalid",
  "limit",
  "read_only",
  "update_failed",
]);
export const SkillResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), entries: z.array(SkillEntry).max(1024), stale: z.boolean() }),
  /** read, create, edit, setAgents and applyUpdate. */
  z.object({
    kind: z.literal("skill"),
    entry: SkillEntry,
    text: body,
    /** setAgents only: agents left in place, with why. */
    kept: z
      .array(
        z.object({
          provider: SkillAgent,
          reason: z.enum(["canonical", "copy", "shared"]),
        }),
      )
      .max(8)
      .optional(),
  }),
  z.object({ kind: z.literal("deleted"), id: SkillId }),
  z.object({
    kind: z.literal("updateStatus"),
    id: SkillId,
    status: z.enum(["current", "available"]),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  }),
  z.object({ kind: z.literal("updateReview"), review: SkillUpdateReview }),
  z.object({ kind: z.literal("cancelled"), reviewId: SkillUpdateReview.shape.id }),
  z.object({ kind: z.literal("usage"), usage: z.array(SkillUsage).max(1024) }),
  z.object({ kind: z.literal("error"), code: SkillErrorCode, message: z.string().max(2048) }),
]);
export type SkillResult = z.infer<typeof SkillResult>;

export const SkillsRequest = z.object({
  type: z.literal("skills.request"),
  requestId: z.string().min(1).max(128),
  operation: SkillOperation,
});
export type SkillsRequest = z.infer<typeof SkillsRequest>;
export const SkillsResult = z.object({
  type: z.literal("skills.result"),
  requestId: z.string(),
  result: SkillResult,
});
export type SkillsResult = z.infer<typeof SkillsResult>;
/** Ends a `list` subscription; disconnect ends them all. */
export const SkillsUnsubscribe = z.object({
  type: z.literal("skills.unsubscribe"),
  requestId: z.string().min(1).max(128),
});
/** A subscribed list changed: skills added, removed, edited or relinked. Usage is read separately. */
export const SkillsChanged = z.object({
  type: z.literal("skills.changed"),
  requestId: z.string(),
  entries: z.array(SkillEntry).max(1024),
  stale: z.boolean(),
});
export type SkillsChanged = z.infer<typeof SkillsChanged>;
