import { z } from "zod";
import { ThreadId } from "./ids.ts";

/** Repository-relative path without NUL bytes. */
const repoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\0"))
  .meta({ "x-ace-constraint": "Repository-relative path without NUL bytes." });

/** Maximum path entries per source control status section. */
export const sourceControlStatusLimit = 500;

/** One file entry inside a staged, unstaged, untracked or conflicted section of `git.status`. */
export const GitStatusSectionEntry = z.object({
  path: repoPath,
  /** A rename's old path. */
  from: repoPath.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked", "conflicted"]),
  /** The file as this status read it; `git.discard` must quote it back. */
  fingerprint: z.string().min(1).max(200),
});
export type GitStatusSectionEntry = z.infer<typeof GitStatusSectionEntry>;

/** One stash entry in a thread checkout's stash stack. */
export const GitStashEntry = z.object({
  ref: z.string().regex(/^stash@\{\d+\}$/),
  index: z.number().int().nonnegative(),
  message: z.string().max(1024),
  branch: z.string().max(1024).optional(),
});
export type GitStashEntry = z.infer<typeof GitStashEntry>;

export const GitSourceControlOperations = [
  /** Branches visible in a thread's checkout, along with its current branch. */
  z.object({ op: z.literal("git.branches"), threadId: ThreadId }),
  /** Stashes recorded in a thread's checkout. */
  z.object({ op: z.literal("git.stash.list"), threadId: ThreadId }),
] as const;

export const GitStashesResult = z.object({
  kind: z.literal("gitStashes"),
  stashes: z.array(GitStashEntry).max(200),
});
export type GitStashesResult = z.infer<typeof GitStashesResult>;

export const GitSourceControlCommands = [
  z.object({
    type: z.literal("git.stage"),
    threadId: ThreadId,
    /** Stage only these repository-relative paths; stage every change when absent. */
    paths: z
      .array(repoPath)
      .min(1)
      .max(2 * sourceControlStatusLimit)
      .optional(),
  }),
  z.object({
    type: z.literal("git.unstage"),
    threadId: ThreadId,
    /** Unstage only these repository-relative paths; unstage every staged change when absent. */
    paths: z
      .array(repoPath)
      .min(1)
      .max(2 * sourceControlStatusLimit)
      .optional(),
  }),
  z.object({
    type: z.literal("git.discard"),
    threadId: ThreadId,
    /**
     * Exactly the files the person confirmed, each with the `fingerprint` the reviewed status
     * showed. A file that changed since is refused (`git_changed_since_review`) and nothing is
     * discarded. Untracked files go to Recently deleted, never removed directly.
     */
    files: z
      .array(z.object({ path: repoPath, fingerprint: z.string().min(1).max(200) }))
      .min(1)
      .max(4 * sourceControlStatusLimit),
  }),
  z.object({
    type: z.literal("git.branch.switch"),
    threadId: ThreadId,
    branch: z.string().min(1).max(1024),
    /** When switching to a remote-tracking branch, names the remote (e.g. "origin"). */
    remote: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal("git.branch.create"),
    threadId: ThreadId,
    branch: z.string().min(1).max(1024),
  }),
  z.object({
    type: z.literal("git.pull"),
    threadId: ThreadId,
    remote: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal("git.fetch"),
    threadId: ThreadId,
    remote: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal("git.stash.push"),
    threadId: ThreadId,
    message: z.string().max(1024).optional(),
    includeUntracked: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("git.stash.pop"),
    threadId: ThreadId,
    /** Stash reference such as `stash@{0}`; defaults to the latest stash. */
    stash: z
      .string()
      .regex(/^stash@\{\d+\}$/)
      .optional(),
  }),
] as const;
