import { ForgeHostedLifecycleCommand } from "./forge-lifecycle.ts";
import {
  SourceControlSelection,
  SourceControlContext,
  SourceControlDraft,
  SourceControlDraftInput,
} from "./source-control-draft.ts";
import { ForgePrWorktree } from "./forge-worktree.ts";
import { ForgeHostedReviewCommand } from "./forge-review.ts";
import { Project } from "./projects.ts";
import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { ForgeBrowserOperations, ForgeBrowserResult } from "./forge-browser.ts";
import { ForgePrStatus, ForgeRepository } from "./forge.ts";
import { Run } from "./thread.ts";
import { ThreadDetails } from "./thread-client.ts";
import { BranchRef } from "./worktree-base.ts";
const id = z.string().min(1).max(128);
export const WorkspaceScript = z.object({
  id,
  name: z.string().max(256),
  source: z.enum(["package.json", "Procfile", "Makefile", "justfile"]),
  command: z.string().max(8192),
});
export type WorkspaceScript = z.infer<typeof WorkspaceScript>;
export const InstalledEditor = z.object({
  id,
  name: z.string().max(256),
  command: z.string().max(4096),
});
export type InstalledEditor = z.infer<typeof InstalledEditor>;
export const EditorLaunch = z.object({ editor: InstalledEditor, path: z.string().max(4096) });
/** A repository-relative path as git reports it. */
const repoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\0"))
  .meta({ "x-ace-constraint": "Repository-relative path without NUL bytes." });
/** One file `git status` reports in a thread's checkout, with its lines changed against HEAD. */
export const GitStatusFile = z.object({
  path: repoPath,
  /** A rename's old path. */
  from: repoPath.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean().default(false),
});
export type GitStatusFile = z.infer<typeof GitStatusFile>;
/** The most files one `git.status` read returns. */
export const gitStatusLimit = 500;
/** A commit message's longest text; Git reads it from stdin, so only the wire bounds it. */
export const maxCommitMessageLength = 65_536;
export const WorkspaceActionRequest = z.object({
  type: z.literal("workspace.request"),
  requestId: id,
  operation: z.discriminatedUnion("op", [
    ...ForgeBrowserOperations,
    z.object({
      op: z.literal("workspaces.list"),
      after: id.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    z.object({ op: z.literal("scripts.list"), threadId: ThreadId }),
    z.object({ op: z.literal("editors.list") }),
    z.object({ op: z.literal("branches.list"), workspaceId: WorkspaceId }),
    z.object({ op: z.literal("thread.details"), threadId: ThreadId }),
    z.object({ op: z.literal("pr.status"), threadId: ThreadId }),
    /** The files a commit of the thread's checkout would take, as `git status` reports them. */
    z.object({ op: z.literal("git.status"), threadId: ThreadId }),
    z.object({ op: z.literal("git.diff"), threadId: ThreadId }),
    z.object({
      op: z.literal("git.draft.context"),
      threadId: ThreadId,
      selection: SourceControlSelection,
    }),
    z.object({
      op: z.literal("git.draft.generate"),
      threadId: ThreadId,
      input: SourceControlDraftInput,
    }),
    z.object({ op: z.literal("git.draft.cancel"), threadId: ThreadId, generationId: id }),
    z.object({
      op: z.literal("runs.list"),
      threadId: ThreadId,
      before: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .default(Number.MAX_SAFE_INTEGER),
      limit: z.number().int().min(1).max(100).default(50),
    }),
  ]),
});
export type WorkspaceActionRequest = z.infer<typeof WorkspaceActionRequest>;
export const WorkspaceActionResult = z.object({
  type: z.literal("workspace.result"),
  requestId: id,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("forge"), data: ForgeBrowserResult }),
    z.object({ kind: z.literal("scripts"), scripts: z.array(WorkspaceScript).max(256) }),
    z.object({ kind: z.literal("editors"), editors: z.array(InstalledEditor).max(32) }),
    z.object({
      kind: z.literal("branches"),
      branches: z.array(z.string().max(1024)).max(1000),
      truncated: z.boolean(),
      /** The same branches told apart: local ones with their upstream, and remotes' ones. */
      refs: z.array(BranchRef).max(1000).optional(),
      /** The repository's default branch (the origin's `HEAD`, else `main` or `master`). */
      defaultBranch: z.string().max(1024).optional(),
      /**
       * HEAD names a branch with no commit yet: there is nothing to start a worktree from. A
       * detached HEAD, or a repository with no branches but a commit, is not unborn.
       */
      unbornHead: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("details"), details: ThreadDetails }),
    z.object({ kind: z.literal("pr"), status: ForgePrStatus.nullable() }),
    z.object({
      kind: z.literal("gitStatus"),
      files: z.array(GitStatusFile).max(gitStatusLimit),
      /** More files changed than `files` holds. */
      truncated: z.boolean(),
      /** The checkout's HEAD when the status was read; null before the first commit. */
      head: z
        .string()
        .regex(/^[a-f0-9]{40,64}$/)
        .nullable()
        .optional(),
      /**
       * Whether the person's commit here runs their Git hooks. `skipped` in a pull request
       * checkout whose hooks live inside it: those are the PR author's programs.
       */
      hooks: z.enum(["run", "skipped"]).optional(),
    }),
    z.object({
      kind: z.literal("gitDiff"),
      patch: z.string().max(262144),
      truncated: z.boolean(),
    }),
    z.object({
      kind: z.literal("runs"),
      runs: z.array(Run).max(100),
      total: z.number().int().nonnegative(),
      nextBefore: z.number().int().positive().optional(),
    }),
    z.object({
      kind: z.literal("workspaces"),
      workspaces: z.array(Project).max(100),
      next: id.optional(),
    }),
    z.object({ kind: z.literal("draftContext"), context: SourceControlContext }),
    z.object({
      kind: z.literal("draft"),
      draft: SourceControlDraft,
      context: SourceControlContext,
    }),
    z.object({ kind: z.literal("draftCancelled") }),
    z.object({ kind: z.literal("error"), code: z.string().max(128) }),
  ]),
});
export type WorkspaceActionResult = z.infer<typeof WorkspaceActionResult>;
export const WorkspaceCommands = [
  z.object({
    type: z.literal("forge.pr.worktree"),
    threadId: ThreadId,
    pullRequest: ForgePrWorktree,
  }),
  ForgeHostedLifecycleCommand,
  ForgeHostedReviewCommand,
  z.object({ type: z.literal("thread.move"), threadId: ThreadId, workspaceId: WorkspaceId }),
  z.object({
    type: z.literal("thread.workspace.set"),
    threadId: ThreadId,
    mode: z.enum(["local", "worktree"]),
    branch: z.string().min(1).max(1024).optional(),
    allowUncommitted: z.boolean().default(false),
  }),
  /**
   * Clear a failed or uncertain checkout move after the person confirms: releases its durable
   * root fence once Git reports the roots available. Fails with `git_quarantined` otherwise.
   */
  z.object({ type: z.literal("thread.workspace.clear"), threadId: ThreadId }),
  /**
   * After `details.worktreeSetup.state === "failed"`: run the setup script again (`retry`) or
   * start without it (`continue`) when the thread's queue resumes.
   */
  z.object({
    type: z.literal("thread.workspace.setup"),
    threadId: ThreadId,
    action: z.enum(["retry", "continue"]),
  }),
  z.object({ type: z.literal("workspace.script.run"), threadId: ThreadId, scriptId: id }),
  z.object({ type: z.literal("workspace.editor.open"), threadId: ThreadId, editorId: id }),
  /**
   * "Clear stale lock", after the person confirms: retire Git mutation leases fencing the
   * thread's checkout whose owning daemon is definitively gone. Fails with `git_quarantined`
   * while a lease's owner may still be alive.
   */
  z.object({ type: z.literal("git.lock.clear"), threadId: ThreadId }),
  z.object({
    type: z.literal("git.commit"),
    threadId: ThreadId,
    message: z
      .string()
      .min(1)
      .max(maxCommitMessageLength)
      .refine((value) => value.trim().length > 0)
      .meta({ "x-ace-constraint": "Must contain a non-whitespace commit message." }),
    draftFingerprint: SourceControlContext.shape.fingerprint.optional(),
    expectedHead: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    /**
     * Commit only these paths; every change when absent. A rename names both its paths, so a
     * full `git.status` page can need twice its file count.
     */
    paths: z
      .array(repoPath)
      .min(1)
      .max(2 * gitStatusLimit)
      .optional(),
  }),
  z.object({
    type: z.literal("git.push"),
    threadId: ThreadId,
    remote: z.string().min(1).max(128).default("origin"),
    /** Pin a PR's pushed head and repository to the checkout the person reviewed. */
    target: z
      .object({
        repository: ForgeRepository,
        branch: z.string().min(1).max(256),
        head: z
          .string()
          .regex(/^[a-f0-9]{40,64}$/)
          .nullable(),
      })
      .optional(),
    /**
     * Replace the remote branch, but only while it still holds `lease`: the remote-tracking
     * revision the person saw (a rejected push's `remoteHead`), never a fresh fetch.
     */
    force: z.object({ lease: z.string().regex(/^[a-f0-9]{40,64}$/) }).optional(),
  }),
] as const;

/** Safe command receipt codes. Git diagnostic text never crosses the wire. */
export const GitActionError = z.enum([
  "git_head_moved",
  "git_conflicts",
  "git_hook_failed",
  /** Not a fast-forward; the result carries `remoteHead` when the tracking ref exists. */
  "git_push_rejected",
  /** A force-with-lease push refused: the remote moved past the leased revision. */
  "git_push_lease_stale",
  /** The remote's branch protection refused the push. */
  "git_protected_branch",
  /** No author name or email is configured for the commit. */
  "git_identity_missing",
  /** The commit had nothing to take. */
  "git_nothing_to_commit",
  /** A PR checkout's head repository is gone, or no configured remote pushes to it. */
  "git_pr_head_unavailable",
  "git_auth_failed",
  "git_failed",
  "git_dirty_worktree",
  "git_invalid_ref",
]);
export type GitActionError = z.infer<typeof GitActionError>;
