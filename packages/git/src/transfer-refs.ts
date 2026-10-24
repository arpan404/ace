import { textOutput } from "./cli.ts";
import { hash } from "./decode.ts";
import { normalizeRemoteUrl } from "./remote-url.ts";
import type { Repository } from "./repository.ts";
import { headCommit, transferRef } from "./transfer-capture.ts";
import { GitError } from "./types.ts";

/** `origin`'s fetch URL as Git would use it (`insteadOf` applied); undefined without one. */
export async function transferOrigin(
  repository: Repository,
  root: string,
): Promise<{ url: string; normalized: string } | undefined> {
  const result = await repository.cli.call(root, ["remote", "get-url", "origin"], {
    allowFailure: true,
  });
  if (result.exitCode === 2) return undefined;
  if (result.exitCode !== 0) throw new GitError("git_failed", "Cannot read the origin remote");
  const url = textOutput(result);
  return url ? { url, normalized: normalizeRemoteUrl(url, root) } : undefined;
}

export async function deleteRef(repository: Repository, root: string, ref: string): Promise<void> {
  await repository.cli.call(root, ["update-ref", "-d", transferRef(ref)], { write: true });
}

export async function assertBranchName(
  repository: Repository,
  root: string,
  name: string,
): Promise<void> {
  const valid = await repository.cli.call(root, ["check-ref-format", "--branch", name], {
    allowFailure: true,
  });
  if (!name || name.startsWith("-") || valid.exitCode !== 0)
    throw new GitError("invalid_ref", `Invalid branch name: ${name}`);
}

/** Create `refs/heads/<name>` at `commit`; `branch_exists` when it is already there. */
export async function createBranch(
  repository: Repository,
  root: string,
  name: string,
  commit: string,
): Promise<void> {
  await assertBranchName(repository, root, name);
  const sha = await repository.commit(root, commit);
  const result = await repository.cli.call(
    root,
    ["update-ref", `refs/heads/${name}`, sha, "0".repeat(sha.length)],
    { write: true, allowFailure: true },
  );
  if (result.exitCode === 0) return;
  if (await refExists(repository, root, `refs/heads/${name}`))
    throw new GitError("branch_exists", `Branch already exists: ${name}`);
  throw new GitError("ref_conflict", `Cannot create branch ${name}`, { stderr: result.stderr });
}

async function refExists(repository: Repository, root: string, ref: string): Promise<boolean> {
  const result = await repository.cli.call(root, ["show-ref", "--verify", "--quiet", ref], {
    allowFailure: true,
  });
  return result.exitCode === 0;
}

/** Full ref names under `prefixes` with the commit each points at. */
export async function refsUnder(
  repository: Repository,
  root: string,
  prefixes: readonly string[],
  directoryFd?: number,
): Promise<Map<string, string>> {
  const output = await repository.cli.call(
    root,
    ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ...prefixes],
    { directoryFd },
  );
  const refs = new Map<string, string>();
  for (const line of output.stdout.toString("utf8").split("\n")) {
    const [name, sha, symref] = line.split("\0");
    if (!name || !sha || symref) continue;
    refs.set(name, hash(sha));
  }
  return refs;
}

export interface BundleRefs {
  /** Local branches, tags and origin-tracking refs, as full ref names. */
  branches: string[];
  tags: string[];
  originTracking: string[];
  /** The checked-out branch's short name; undefined when detached or unborn. */
  branch?: string;
  /** HEAD's commit; undefined when unborn. */
  head?: string;
}

export async function bundleRefs(repository: Repository, root: string): Promise<BundleRefs> {
  const refs = [
    ...(
      await refsUnder(repository, root, ["refs/heads", "refs/tags", "refs/remotes/origin"])
    ).keys(),
  ];
  const current = await repository.cli.call(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowFailure: true,
  });
  const head = await headCommit(repository, root);
  const branch = current.exitCode === 0 && head ? textOutput(current) : undefined;
  return {
    branches: refs.filter((ref) => ref.startsWith("refs/heads/")),
    tags: refs.filter((ref) => ref.startsWith("refs/tags/")),
    originTracking: refs.filter((ref) => ref.startsWith("refs/remotes/origin/")),
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
  };
}
