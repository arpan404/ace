import { GitError, type GitService } from "@ace/git";
import type { WorktreeBaseRecord } from "@ace/protocol";
import type { RequestedBase } from "./worktree-base.ts";

/** How long a remote base's fetch may take before the last fetched copy is used instead. */
export const defaultBaseFetchTimeoutMs = 15_000;

export type WorktreeBaseErrorCode = "worktree_base_not_found" | "worktree_base_unreachable";

/** A requested base that can't be started from; its code is the command's public error. */
export class WorktreeBaseError extends Error {
  readonly code: WorktreeBaseErrorCode;
  readonly title: string;
  constructor(code: WorktreeBaseErrorCode, title: string, detail: string) {
    super(detail);
    this.code = code;
    this.title = title;
  }
}

type BaseGit = Pick<GitService, "resolveCommit" | "branchHead" | "fetchBranch">;

/** Fetch failures that mean "the remote couldn't be reached", where a cached copy will do. */
const unreachable = new Set(["remote_unreachable", "auth_failed", "git_timeout", "git_failed"]);
/** Fetch failures that mean the remote (or the name) has no such branch. */
const missing = new Set(["remote_ref_not_found", "invalid_ref", "invalid_argument"]);

function notFound(requested: { ref: string; remote?: string }): WorktreeBaseError {
  const name = requested.remote ? `${requested.remote}/${requested.ref}` : requested.ref;
  return new WorktreeBaseError(
    "worktree_base_not_found",
    "Branch not found",
    `There is no branch ${name} to start the worktree from.`,
  );
}

/**
 * The commit a new worktree starts at. A local branch is read as-is; a remote branch is fetched
 * first (that one branch, bounded by `fetchTimeoutMs`), falling back to the last fetched copy
 * when the remote can't be reached. Only the one remote-tracking ref can move.
 */
export async function resolveWorktreeBase(
  git: BaseGit,
  project: string,
  requested: RequestedBase,
  fetchTimeoutMs: number,
  io: { signal?: AbortSignal; stderr?: (chunk: Buffer) => void } = {},
): Promise<{ head: string; record?: WorktreeBaseRecord }> {
  if (requested.kind === "revision")
    return { head: await git.resolveCommit({ worktree: project, ref: requested.revision }) };
  const { ref, remote } = requested;
  if (remote === undefined) {
    const head = await branchHead(git, project, ref);
    if (!head) throw notFound(requested);
    return { head, record: { ref, head } };
  }
  let fetch: "fetched" | "unreachable" = "fetched";
  try {
    await git.fetchBranch({ repo: project, remote, branch: ref, timeoutMs: fetchTimeoutMs, ...io });
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (missing.has(error.code)) throw notFound(requested);
    if (!unreachable.has(error.code)) throw error;
    fetch = "unreachable";
  }
  const head = await branchHead(git, project, ref, remote);
  if (head) return { head, record: { ref, remote, head, fetch } };
  if (fetch === "fetched") throw notFound(requested);
  throw new WorktreeBaseError(
    "worktree_base_unreachable",
    "Remote unreachable",
    `Couldn't reach ${remote} to fetch ${ref}, and there is no earlier copy of it.`,
  );
}

async function branchHead(
  git: BaseGit,
  project: string,
  branch: string,
  remote?: string,
): Promise<string | undefined> {
  try {
    return await git.branchHead({ repo: project, branch, remote });
  } catch (error) {
    if (error instanceof GitError && missing.has(error.code)) return undefined;
    throw error;
  }
}
