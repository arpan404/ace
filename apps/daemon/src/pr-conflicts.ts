import { repositoryKey } from "@ace/forge";
import type { GitService } from "@ace/git";
import type {
  CommandResult,
  ForgePrRef,
  ForgePrWorkspace,
  ForgeRepository,
  GitConflictStep,
  GitConflicts,
} from "@ace/protocol";
import { prRemote, type PrRemotes } from "./pr-worktree-resolution.ts";

export type PrConflictGit = Pick<
  GitService,
  | "repositoryInfo"
  | "fetchBranch"
  | "branchHead"
  | "startMerge"
  | "abortMerge"
  | "conflicts"
  | "writeResolution"
  | "takeSide"
  | "commitMerge"
  | "asReviewer"
>;

export interface PrConflictContext {
  git: PrConflictGit;
  /** The thread's checkout. */
  cwd: string;
  /** The pull request that checkout holds, if it holds one. */
  held: ForgePrWorkspace | undefined;
  /** Picks the remote of the PR's base repository; `prRemote` unless a test substitutes it. */
  remote?: ((remotes: PrRemotes, repository: ForgeRepository) => string) | undefined;
  hostAliases?:
    | ((urls: readonly string[], signal: AbortSignal) => Promise<Record<string, string>>)
    | undefined;
  /** Throws once the person may no longer act; checked before each write. */
  allowed(): void;
  signal: AbortSignal;
}

const baseFetchTimeoutMs = 120_000;

/** The checkout's PR when it's the one asked about; conflicts belong to that PR only. */
export function heldPr(held: ForgePrWorkspace | undefined, pr: ForgePrRef) {
  return held &&
    held.ref.number === pr.number &&
    repositoryKey(held.ref.repository) === repositoryKey(pr.repository)
    ? held
    : undefined;
}

/** The conflicts in the checkout of `pr`, or null when the thread's checkout holds another. */
export async function readPrConflicts(
  context: Pick<PrConflictContext, "git" | "cwd" | "held">,
  pr: ForgePrRef,
): Promise<GitConflicts | null> {
  return heldPr(context.held, pr) ? context.git.conflicts(context.cwd) : null;
}

/**
 * One step of resolving a pull request's conflicts in its checkout: merge its base in, resolve
 * files, abort, or commit. Pushing the merge is `git.push`, which updates the PR's head branch
 * without force, so a head that moved on the host refuses instead of being overwritten.
 */
export async function runPrConflictStep(
  context: PrConflictContext,
  pr: ForgePrRef,
  step: GitConflictStep,
): Promise<Omit<CommandResult, "commandId">> {
  const held = heldPr(context.held, pr);
  if (!held) return { ok: false, error: "git_pr_head_unavailable" };
  const { git, cwd } = context;
  if (step.action === "start") {
    const info = await git.repositoryInfo(cwd);
    const remote = context.remote
      ? context.remote(info.remotes, held.ref.repository)
      : prRemote(
          info.remotes,
          held.ref.repository,
          (await context.hostAliases?.(
            info.remotes.flatMap((entry) => entry.fetchUrls),
            context.signal,
          )) ?? {},
        );
    await git.fetchBranch({
      repo: cwd,
      remote,
      branch: held.baseBranch,
      timeoutMs: baseFetchTimeoutMs,
      signal: context.signal,
    });
    const revision = await git.branchHead({ repo: cwd, branch: held.baseBranch, remote });
    if (!revision) return { ok: false, error: "git_invalid_ref" };
    context.allowed();
    const state = await git.startMerge({
      worktree: cwd,
      revision,
      expectedHead: step.expectedHead,
      message: `Merge branch '${held.baseBranch}' into ${held.headBranch}`,
    });
    return { ok: true, code: `merge_${state}` };
  }
  context.allowed();
  if (step.action === "abort") await git.abortMerge(cwd);
  else if (step.action === "write") {
    const { staged } = await git.writeResolution({
      worktree: cwd,
      path: step.path,
      content: step.content,
      revision: step.revision,
    });
    return { ok: true, code: staged ? "conflict_resolved" : "conflict_written" };
  } else if (step.action === "take")
    await git.takeSide({ worktree: cwd, path: step.path, side: step.side });
  else {
    // The person's merge commit: their signing, but no hook that lives inside the PR's code.
    const commit = await git.asReviewer(() =>
      git.commitMerge({ worktree: cwd, expectedHead: step.expectedHead, message: step.message }),
    );
    return { ok: true, commit };
  }
  return { ok: true };
}
