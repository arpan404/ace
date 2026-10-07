import { z } from "zod";

/** A remote's name as `git remote` lists it: `origin`, `upstream`. */
const RemoteName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.-]+$/)
  .refine((name) => !name.startsWith("-") && !name.startsWith("."))
  .meta({
    "x-ace-constraint": "A remote name: letters, digits, `_`, `.`, `-`; no leading `-` or `.`.",
  });

/**
 * Where a new worktree starts: one of the project's local branches, or a branch on one of its
 * remotes. A remote base is fetched (that one branch, bounded by a timeout) just before the
 * worktree is made, so the thread starts from what the remote has now; when the remote can't be
 * reached the last fetched copy is used and the thread's `details.base` says so. The worktree
 * gets a new local branch of its own with no upstream, so its first push sets one of the same
 * name and can never land on the base branch. Sent on `thread.create` / `thread.prepare`; wins
 * over `baseBranch` when both are set. The command fails with `worktree_base_not_found` when the
 * branch doesn't exist (locally, or on a remote that answered), and `worktree_base_unreachable`
 * when the remote couldn't be reached and the branch was never fetched.
 */
export const WorktreeBase = z.object({
  /** The branch's name without the remote: `main`, `feature/login`. */
  ref: z.string().min(1).max(1024),
  /** The remote the branch is on; absent for a local branch. */
  remote: RemoteName.optional(),
});
export type WorktreeBase = z.infer<typeof WorktreeBase>;

/** The base a thread's worktree was made from, as recorded in its details. */
export const WorktreeBaseRecord = WorktreeBase.extend({
  /** The commit the worktree started at. */
  head: z.string().regex(/^[a-f0-9]{40,64}$/),
  /**
   * A remote base only: `fetched` when the branch was fetched just before, `unreachable` when
   * the remote couldn't be reached and the last fetched copy was used.
   */
  fetch: z.enum(["fetched", "unreachable"]).optional(),
});
export type WorktreeBaseRecord = z.infer<typeof WorktreeBaseRecord>;

/**
 * One branch a worktree can start from, in `branches.list`'s `refs`: a local branch (with how
 * far it is from its upstream, as of the last fetch) or a remote's branch. Remotes' symbolic
 * `HEAD` refs are left out.
 */
export const BranchRef = z.object({
  /** The branch's name without the remote. */
  name: z.string().min(1).max(1024),
  /** The remote it is on; absent for a local branch. */
  remote: RemoteName.optional(),
  /** A local branch's upstream, `origin/main`. */
  upstream: z.string().max(1200).optional(),
  /** Commits the local branch has that its upstream doesn't (as of the last fetch). */
  ahead: z.number().int().nonnegative().optional(),
  /** Commits its upstream has that the local branch doesn't (as of the last fetch). */
  behind: z.number().int().nonnegative().optional(),
});
export type BranchRef = z.infer<typeof BranchRef>;
