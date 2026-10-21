import { z } from "zod";
import { ForgePrRef } from "./forge.ts";
import { ThreadId } from "./ids.ts";

/**
 * Merge conflicts in a pull request's checkout: the PR's base merged into its head, resolved
 * file by file in the checkout, then committed and pushed to the head branch.
 */

/** The largest file whose hunks a read carries, and the largest resolution a write takes. */
export const maxConflictFileBytes = 131_072;
/** The most conflicted files one read lists. */
export const conflictFileLimit = 200;

const repoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\0"))
  .meta({ "x-ace-constraint": "Repository-relative path without NUL bytes." });
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
/** SHA-256 of the file's bytes as read, so a write can't overwrite an edit made since. */
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const markerLine = z.string().max(4096);
const body = z.string().max(maxConflictFileBytes);

/** One conflict hunk: each side's lines and Git's marker lines, verbatim with line endings. */
export const GitConflictHunk = z.object({
  kind: z.literal("conflict"),
  ours: body,
  /** The merge base's lines; null when Git wrote no base section. */
  base: body.nullable(),
  theirs: body,
  markers: z.object({
    ours: markerLine,
    base: markerLine.nullable(),
    separator: markerLine,
    theirs: markerLine,
  }),
});
export type GitConflictHunk = z.infer<typeof GitConflictHunk>;
export const GitConflictSegment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: body }),
  GitConflictHunk,
]);
export type GitConflictSegment = z.infer<typeof GitConflictSegment>;

export const GitConflictFile = z.object({
  path: repoPath,
  /** Which of the merge's three versions have this path: the base, ours (HEAD), theirs. */
  stages: z.object({ base: z.boolean(), ours: z.boolean(), theirs: z.boolean() }),
  content: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text"),
      revision,
      segments: z.array(GitConflictSegment).max(20_000),
    }),
    /** Only a whole side can be taken: binary, too large, missing, or not a regular file. */
    z.object({
      kind: z.literal("unavailable"),
      reason: z.enum(["binary", "too_large", "missing", "unsupported"]),
    }),
  ]),
});
export type GitConflictFile = z.infer<typeof GitConflictFile>;

export const GitConflicts = z.object({
  /** The checkout's HEAD; null before its first commit. */
  head: commit.nullable(),
  /** A merge is in progress (`MERGE_HEAD` exists). */
  merging: z.boolean(),
  /** Tracked changes outside a merge: a merge can't start until they're committed or gone. */
  dirty: z.boolean(),
  /** Paths Git still lists as unmerged, in path order. */
  files: z.array(GitConflictFile).max(conflictFileLimit),
  truncated: z.boolean(),
});
export type GitConflicts = z.infer<typeof GitConflicts>;

export const GitConflictsOperation = z.object({
  op: z.literal("git.conflicts"),
  threadId: ThreadId,
  /** The pull request the thread's checkout must hold; the result is null otherwise. */
  pr: ForgePrRef,
});
export const GitConflictsResult = z.object({
  kind: z.literal("gitConflicts"),
  conflicts: GitConflicts.nullable(),
});

export const GitConflictStep = z.discriminatedUnion("action", [
  /** Fetch the PR's base and merge it into the checkout, stopping before the commit. */
  z.object({ action: z.literal("start"), expectedHead: commit }),
  /** `git merge --abort`: the checkout goes back to HEAD. */
  z.object({ action: z.literal("abort") }),
  /** Write the file's new text; staged once no conflict hunk is left in it. */
  z.object({
    action: z.literal("write"),
    path: repoPath,
    content: body,
    revision,
  }),
  /** Take one side's whole file (deleting it when that side deleted it), and stage it. */
  z.object({ action: z.literal("take"), path: repoPath, side: z.enum(["ours", "theirs"]) }),
  /** Commit the merge with what is staged and the message Git prepared, once nothing is unmerged. */
  z.object({ action: z.literal("commit"), expectedHead: commit }),
]);
export type GitConflictStep = z.infer<typeof GitConflictStep>;
export const GitConflictsCommand = z.object({
  type: z.literal("git.conflicts"),
  threadId: ThreadId,
  /** The pull request the thread's checkout must hold. */
  pr: ForgePrRef,
  step: GitConflictStep,
});
