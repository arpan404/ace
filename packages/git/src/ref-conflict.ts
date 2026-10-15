import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

/**
 * Refs are files: branch `ace` and branch `ace/1f2e` cannot both exist. Name the existing branch
 * that blocks a new one, before Git fails with a lock error.
 */
export async function assertNoRefConflict(
  repository: Repository,
  root: string,
  branch: string,
): Promise<void> {
  const parts = branch.split("/");
  for (let length = 1; length < parts.length; length++) {
    const prefix = parts.slice(0, length).join("/");
    const found = await repository.cli.call(
      root,
      ["show-ref", "--verify", "--quiet", `refs/heads/${prefix}`],
      { allowFailure: true },
    );
    if (found.exitCode === 0) throw conflict(branch, prefix);
  }
  const below = await repository.cli.call(
    root,
    ["for-each-ref", "--count=1", "--format=%(refname:short)", `refs/heads/${branch}/`],
    { captureBytes: 8192 },
  );
  const existing = below.stdout.toString("utf8").trim();
  if (existing) throw conflict(branch, existing);
}

function conflict(branch: string, existing: string): GitError {
  return new GitError(
    "ref_conflict",
    `Branch ${branch} can't be created while branch ${existing} exists`,
    { branch, conflictsWith: existing },
  );
}
