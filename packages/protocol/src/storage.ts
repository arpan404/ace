import { z } from "zod";

export const StorageKind = z.enum([
  "threads",
  "attachments",
  "artifacts",
  "logs",
  "worktrees",
  "caches",
]);
export type StorageKind = z.infer<typeof StorageKind>;
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(256);
const days = z.number().int().min(1).max(36500).nullable();
/** Null disables removal of a category. Scheduling is always an explicit host preference. */
export const StorageRetention = z.object({
  threads: days.default(90),
  attachments: days.default(30),
  artifacts: days.default(30),
  logs: days.default(14),
  worktrees: days.default(30),
  caches: days.default(7),
});
export type StorageRetention = z.infer<typeof StorageRetention>;
export const StorageReason = z.enum([
  "retention_disabled",
  "within_retention",
  "archived_thread",
  "not_archived",
  "pinned",
  "active_tree",
  "pending_input",
  "live_thread",
  "referenced",
  "leased",
  "unowned",
  "expired",
  "task_finished",
  "pr_merged",
  "pr_closed",
  "orphaned",
  "missing_directory",
  "main_worktree",
  "locked_worktree",
  "uncommitted",
  "unpushed",
  "unknown_git_state",
  "unsafe_path",
  "changed",
  "already_removed",
  "cleanup_in_progress",
  "owner_unavailable",
]);
export type StorageReason = z.infer<typeof StorageReason>;
export const StorageItem = z.object({
  id,
  kind: StorageKind,
  label: z.string().max(4096),
  bytes,
  modifiedAt: bytes,
  threadIds: z.array(z.string().max(128)).max(256),
  disposition: z.enum(["remove", "protect"]),
  reasons: z.array(StorageReason).min(1).max(16),
  forced: z.boolean(),
  branch: z.string().max(1024).nullable().optional(),
  removeBranch: z.boolean().optional(),
  effects: z
    .array(
      z.enum([
        "transcript_payloads",
        "attachment_references",
        "browser_data",
        "worktree",
        "local_branch",
        "file",
      ]),
    )
    .max(6)
    .default([]),
});
export type StorageItem = z.infer<typeof StorageItem>;
export const StorageUsage = z.object({
  categories: z.array(z.object({ kind: StorageKind, bytes, items: bytes })).max(6),
  databaseBytes: bytes,
  reclaimableDatabaseBytes: bytes,
  measuredAt: bytes,
  complete: z.boolean(),
});
export type StorageUsage = z.infer<typeof StorageUsage>;
export const StoragePlan = z.object({
  id,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: bytes,
  expiresAt: bytes,
  retention: StorageRetention,
  items: z.array(StorageItem).max(256),
  bytes,
  complete: z.boolean(),
});
export type StoragePlan = z.infer<typeof StoragePlan>;
export const StorageApply = z.object({
  planId: id,
  state: z.enum(["complete", "pending", "stale"]),
  items: z
    .array(
      z.object({
        id,
        state: z.enum(["removed", "pending", "protected"]),
        reason: StorageReason.optional(),
        error: z.string().max(128).optional(),
      }),
    )
    .max(256),
  compaction: z.enum(["not_requested", "complete", "deferred"]),
});
export type StorageApply = z.infer<typeof StorageApply>;
export const StorageRequest = z.object({
  type: z.literal("storage.request"),
  requestId: z.string().min(1).max(128),
  operation: z.discriminatedUnion("op", [
    z.object({ op: z.literal("storage.usage") }),
    z.object({
      op: z.literal("cleanup.plan"),
      kinds: z.array(StorageKind).min(1).max(6).optional(),
      retention: StorageRetention.optional(),
      forceItems: z.array(id).max(256).default([]),
    }),
    z.object({
      op: z.literal("cleanup.apply"),
      planId: id,
      revision: StoragePlan.shape.revision,
      compact: z.boolean().default(false),
    }),
    z.object({ op: z.literal("cleanup.status"), planId: id }),
  ]),
});
export type StorageRequest = z.infer<typeof StorageRequest>;
export const StorageResult = z.object({
  type: z.literal("storage.result"),
  requestId: z.string().min(1).max(128),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("usage"), usage: StorageUsage }),
    z.object({ kind: z.literal("plan"), plan: StoragePlan }),
    z.object({ kind: z.literal("apply"), apply: StorageApply }),
    z.object({
      kind: z.literal("error"),
      code: z.enum(["forbidden", "busy", "not_found", "invalid_request", "unavailable"]),
      message: z.string().max(256),
    }),
  ]),
});
export type StorageResult = z.infer<typeof StorageResult>;
