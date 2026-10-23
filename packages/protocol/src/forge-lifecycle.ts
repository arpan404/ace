import { z } from "zod";
import { ForgePrRef, ForgeRepository } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";
const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const name = z.string().min(1).max(256);
export const ForgePrMetadata = z.object({
  title: z.string().min(1).max(256),
  body: text,
  baseBranch: name,
  labels: z.array(name).max(100),
  assignees: z
    .array(
      z
        .string()
        .regex(/^[\w-]+$/)
        .max(100),
    )
    .max(100),
  /** The milestone's number; null clears it. Absent when the host didn't say. */
  milestone: z.number().int().positive().nullable().optional(),
});
export type ForgePrMetadata = z.infer<typeof ForgePrMetadata>;
export const ForgeLifecycleActionName = z.enum([
  "ready",
  "draft",
  "close",
  "reopen",
  "update.merge",
  "update.rebase",
  "revert",
  "lock",
  "unlock",
  "branch.delete",
  "branch.restore",
  "issue.link",
  "issue.unlink",
]);
/** GitHub's reasons for locking a conversation. */
export const ForgeLockReason = z.enum(["off_topic", "too_heated", "resolved", "spam"]);
export type ForgeLockReason = z.infer<typeof ForgeLockReason>;
const issueRef = z.object({ repository: ForgeRepository, number: z.number().int().positive() });
/** An issue the pull request closes when it merges into the default branch. */
export const ForgeClosingIssue = z.object({
  ref: issueRef,
  title: text,
  state: z.enum(["open", "closed"]),
  url: text,
  /** Linked by hand (GitHub's Development field) rather than by a keyword in the body. */
  manual: z.boolean(),
});
export type ForgeClosingIssue = z.infer<typeof ForgeClosingIssue>;
export const ForgeLifecycleSnapshot = z.object({
  pr: ForgePrRef,
  id: name,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  headSha: sha,
  baseSha: sha,
  state: z.enum(["open", "draft", "closed", "merged"]),
  metadata: ForgePrMetadata,
  editableFields: z
    .array(z.enum(["title", "body", "baseBranch", "labels", "assignees", "milestone"]))
    .max(6),
  actions: z.array(ForgeLifecycleActionName).max(13),
  unsupported: z.array(ForgeLifecycleActionName).max(13),
  /** The milestone the PR is in, or null for none; absent when the host didn't say. */
  milestone: z
    .object({
      number: z.number().int().positive(),
      title: text,
      state: z.enum(["open", "closed"]),
      dueOn: text.nullable(),
    })
    .nullable()
    .optional(),
  /** The conversation's lock, and whether this account may still comment while locked. */
  conversation: z
    .object({
      locked: z.boolean(),
      reason: ForgeLockReason.nullable(),
      viewerCanComment: z.boolean(),
    })
    .optional(),
  /** The head branch on GitHub: whether it still exists and where it lives. */
  headBranch: z
    .object({
      name: name,
      exists: z.boolean(),
      /** In this repository, not a fork. */
      sameRepository: z.boolean(),
      /** The repository's default branch: never offered for deletion. */
      isDefault: z.boolean(),
      /** GitHub deletes head branches itself once a PR merges. */
      deleteOnMerge: z.boolean(),
      /** Other open PRs whose head is this branch: it is kept while they are open. */
      usedBy: z.array(z.number().int().positive()).max(10).optional(),
    })
    .optional(),
  /** Issues this PR closes when merged, as GitHub links them. */
  closingIssues: z.array(ForgeClosingIssue).max(50).optional(),
});
export type ForgeLifecycleSnapshot = z.infer<typeof ForgeLifecycleSnapshot>;
export const ForgeLifecycleAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), changes: ForgePrMetadata.partial() }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("draft") }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("reopen") }),
  z.object({ kind: z.literal("update.merge") }),
  z.object({ kind: z.literal("update.rebase") }),
  z.object({
    kind: z.literal("revert"),
    title: z.string().min(1).max(256),
    body: z.string().max(60_000),
  }),
  /** Lock the conversation, with GitHub's reason or none. */
  z.object({ kind: z.literal("lock"), reason: ForgeLockReason.nullable() }),
  z.object({ kind: z.literal("unlock") }),
  /** Delete the head branch on GitHub. Local branches and worktrees are never touched. */
  z.object({ kind: z.literal("branch.delete") }),
  /** Recreate a deleted head branch at the PR's head commit. */
  z.object({ kind: z.literal("branch.restore") }),
  /** Link an issue of this repository for the PR to close (GitHub's Development field). */
  z.object({ kind: z.literal("issue.link"), issue: z.number().int().positive() }),
  /** Remove a hand-made link. Keyword links live in the body and are edited there. */
  z.object({ kind: z.literal("issue.unlink"), issue: issueRef }),
]);
export type ForgeLifecycleAction = z.infer<typeof ForgeLifecycleAction>;
export const ForgeLifecycleReceipt = z.object({
  outcome: z.enum(["accepted", "pending", "head_changed"]),
  headSha: sha,
  revertPr: ForgePrRef.optional(),
});
export type ForgeLifecycleReceipt = z.infer<typeof ForgeLifecycleReceipt>;
export const ForgeHostedLifecycleCommand = z.object({
  type: z.literal("forge.hosted.lifecycle"),
  workspaceId: WorkspaceId,
  pr: ForgePrRef,
  operation: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("apply"),
      expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
      action: ForgeLifecycleAction,
    }),
    z.object({ kind: z.literal("reconcile"), operationId: name }),
  ]),
});
export const ForgeLifecycleState = z.object({
  snapshot: ForgeLifecycleSnapshot,
  operations: z
    .array(
      z.object({
        id: name,
        kind: z.string().max(100),
        state: z.enum(["accepted", "pending", "uncertain", "head_changed"]),
        revertPr: ForgePrRef.optional(),
      }),
    )
    .max(100),
});
export type ForgeLifecycleState = z.infer<typeof ForgeLifecycleState>;
