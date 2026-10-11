import { GitError } from "./types.ts";

/** The remote used by the daemon's repository discovery and PR publication. */
export function publicationRemote<Remote extends { name: string }>(
  remotes: readonly Remote[],
): Remote | undefined {
  return remotes.find((remote) => remote.name === "origin") ?? remotes[0];
}

/** Cross-remote PR creation is unsupported; a reviewed diff must target the publication remote. */
export function assertPrBase(
  ref: string,
  branch: string,
  remote: { name: string } | undefined,
): void {
  if (ref === `refs/heads/${branch}`) return;
  if (remote && ref === `refs/remotes/${remote.name}/${branch}`) return;
  throw new GitError(
    "pr_base_mismatch",
    "PR draft base must match the publication remote and target branch; cross-remote PR drafts are unsupported",
  );
}
