import type { ForgeRepositoryMetadata } from "@ace/forge";
import type { ForgeRepository, ThreadDetails } from "@ace/protocol";

/** Where a thread's new PR is opened: which repository, into which base, from whose branch. */
export type PrCreateTarget = {
  /** The fork's parent when the pushed repository is a fork, else the pushed repository. */
  repository: ForgeRepository;
  base: string;
  /** The repository that holds the pushed branch, owner and name: a fork may share its owner. */
  head: { owner: string; name: string };
};

/**
 * A base label as the forge names the branch: `origin/main` and `refs/remotes/origin/main`
 * become `main`. A commit or `HEAD` names no branch.
 */
export function forgeBranchName(label: string, remotes: readonly string[]): string | undefined {
  if (label === "HEAD" || /^[a-f0-9]{7,64}$/.test(label)) return undefined;
  const local = /^refs\/heads\/(.+)$/.exec(label);
  if (local) return local[1];
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(label);
  if (remote) return remote[1];
  const prefix = remotes.find((name) => label.startsWith(`${name}/`));
  return prefix ? label.slice(prefix.length + 1) : label;
}

/**
 * The branch a thread recorded as its base. The head branch itself is no PR base, so the
 * caller falls back to the repository's default branch.
 */
export function recordedPrBase(
  details: Pick<ThreadDetails, "base" | "baseBranch"> | undefined,
  headBranch: string,
  remotes: readonly string[],
): string | undefined {
  const name = details?.base
    ? details.base.ref
    : details?.baseBranch
      ? forgeBranchName(details.baseBranch, remotes)
      : undefined;
  return name && name !== headBranch ? name : undefined;
}

/**
 * A fork's PRs belong to its parent. The base is the one the person reviewed (a draft's
 * fingerprinted base), else the thread's recorded base, else the target's default branch;
 * never a guessed `main`.
 */
export function prCreateTarget(
  pushed: ForgeRepository,
  metadata: ForgeRepositoryMetadata,
  base: { reviewed?: string | undefined; recorded?: string | undefined },
): PrCreateTarget {
  const parent = metadata.parent;
  return {
    repository: parent?.repository ?? pushed,
    base: base.reviewed ?? base.recorded ?? parent?.defaultBranch ?? metadata.defaultBranch,
    head: { owner: pushed.owner, name: pushed.name },
  };
}
