import { GitError, type GitService, type Worktree } from "@ace/git";
import { lstat } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import { CreationError } from "./creation-failure.ts";

/** How long read-only Git work before `git worktree add` may take; 10 minutes by default. */
export const defaultPreparationTimeoutMs = 600_000;

/** Environment variable overriding the worktree preparation deadline. */
export const preparationTimeoutMsEnvVar = "ACE_WORKTREE_PREPARATION_TIMEOUT_MS";

/**
 * Which preparation deadline to use: an explicit per-environment setting wins, then
 * `ACE_WORKTREE_PREPARATION_TIMEOUT_MS`, then 10 minutes. Invalid values fall through.
 */
export function resolvePreparationTimeoutMs(
  explicit?: number | undefined,
  env: NodeJS.ProcessEnv = {},
): number {
  if (explicit !== undefined && Number.isInteger(explicit) && explicit > 0) return explicit;
  const raw = env[preparationTimeoutMsEnvVar];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return defaultPreparationTimeoutMs;
}

/**
 * Stop waiting for read-only Git work when `signal` aborts. The read itself may finish later;
 * nothing depends on it, and it writes nothing, so abandoning it is safe.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** A timeout reads as `preparation_timeout`; a person's Cancel or Use local keeps its own reason. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? new CreationError("preparation_timeout", { cause: signal.reason })
    : signal.reason;
}

/** The preparation phase's own deadline, ending early with the caller's signal. */
export function preparationSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

type BranchGit = Pick<GitService, "resolveCommit">;
async function branchExists(
  git: BranchGit,
  repo: string,
  branch: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await git.resolveCommit({ worktree: repo, ref: `refs/heads/${branch}`, signal });
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === "invalid_ref") return false;
    throw error;
  }
}

/**
 * The branch a new worktree gets: `ace/<key>`, or `ace/<key>-2`... when an earlier attempt's
 * cleanup kept a branch with commits. A kept branch is never adopted or overwritten.
 */
export async function freeBranch(
  git: BranchGit,
  repo: string,
  branch: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const candidate = attempt === 1 ? branch : `${branch}-${attempt}`;
    if (!(await abortable(branchExists(git, repo, candidate, signal), signal))) return candidate;
  }
  throw new Error("workspace_preparation_collision");
}

/** HEAD of a repository with no commits is not a missing ref but a missing history. */
export async function noCommits(git: BranchGit, repo: string, error: unknown): Promise<boolean> {
  if (error instanceof GitError && error.code === "unborn_head") return true;
  if (!(error instanceof GitError && error.code === "invalid_ref")) return false;
  try {
    await git.resolveCommit({ worktree: repo, ref: "HEAD" });
    return false;
  } catch (head) {
    return head instanceof GitError && head.code === "invalid_ref";
  }
}

const within = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

/** Whether `path` is `root` itself or somewhere inside it. */
export function insideRoot(root: string, path: string): boolean {
  return within(root, path);
}

/**
 * Where a thread runs in a new checkout of `project`'s repository: the same subfolder of
 * `checkout` that `project` is of its own checkout, or the checkout's top when it has none.
 */
export async function checkoutCwd(
  trees: readonly Pick<Worktree, "path">[],
  project: string,
  checkout: string,
): Promise<string> {
  const top = trees
    .map((tree) => tree.path)
    .filter((path) => within(path, project))
    .toSorted((a, b) => b.length - a.length)[0];
  const sub = top ? relative(top, project) : "";
  if (!sub) return checkout;
  const cwd = join(checkout, sub);
  try {
    if ((await lstat(cwd)).isDirectory()) return cwd;
  } catch {
    /* An untracked project folder has no copy in the new checkout. */
  }
  return checkout;
}
