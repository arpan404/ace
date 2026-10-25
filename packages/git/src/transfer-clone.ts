import { validateCloneUrl, type ProjectGitPolicy } from "./projects.ts";
import { textOutput } from "./cli.ts";
import { longWriteTimeoutMs } from "./deadlines.ts";
import type { Repository } from "./repository.ts";
import { fetchBundle } from "./transfer-bundle.ts";
import { assertBundleFile } from "./transfer-bundle-file.ts";
import { refsUnder } from "./transfer-refs.ts";
import { GitError } from "./types.ts";

export interface BundleCloneOptions {
  /** The folder holding `path`; kept for parity with `clone`. */
  parent: string;
  /** An empty folder: created first unless `directoryFd` already holds it open. */
  path: string;
  bundle: string;
  /** Original fetch URL, never the temporary bundle path. */
  origin?: string | undefined;
  /** The branch to check out; else the branch at the bundle's HEAD, `main`, `master`, or the first. */
  branch?: string | undefined;
  directoryFd?: number | undefined;
}

/**
 * A new repository holding every branch, tag and `refs/ace/*` ref of the bundle as its own,
 * with `branch` checked out. This is what cloning the bundle and removing its remote leaves,
 * done directly: no remote pointing at the bundle file is ever configured. The caller removes
 * `path` when this fails, as it created it.
 */
export async function cloneFromBundle(
  repository: Repository,
  input: BundleCloneOptions,
  policy: ProjectGitPolicy = {},
): Promise<{ branch: string | undefined }> {
  if (input.origin) (policy.validateUrl ?? validateCloneUrl)(input.origin);
  await assertBundleFile(input.bundle);
  const { cli } = repository;
  const at = { directoryFd: input.directoryFd };
  await cli.call(input.path, ["init", "--quiet", "--", "."], { write: true, ...at });
  await fetchBundle(
    repository,
    input.path,
    input.bundle,
    [
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
      "+refs/ace/*:refs/ace/*",
      ...(input.origin ? ["+refs/remotes/origin/*:refs/remotes/origin/*"] : []),
    ],
    { updateHead: true, ...at },
  );
  if (input.origin)
    await cli.call(input.path, ["remote", "add", "origin", input.origin], { write: true, ...at });
  const heads = await refsUnder(repository, input.path, ["refs/heads"], input.directoryFd);
  const branch = input.branch ?? (await bundleBranch(repository, input, heads));
  if (branch === undefined) return { branch: undefined };
  if (!heads.has(`refs/heads/${branch}`))
    throw new GitError("invalid_ref", `The bundle has no branch ${branch}`);
  await cli.call(input.path, ["symbolic-ref", "HEAD", `refs/heads/${branch}`], {
    write: true,
    ...at,
  });
  await cli.call(input.path, ["reset", "--hard", "--quiet", "HEAD"], {
    write: true,
    timeoutMs: longWriteTimeoutMs,
    ...at,
  });
  if (input.origin) {
    const tracking = await refsUnder(
      repository,
      input.path,
      ["refs/remotes/origin"],
      input.directoryFd,
    );
    if (tracking.has(`refs/remotes/origin/${branch}`))
      await cli.call(input.path, ["branch", `--set-upstream-to=origin/${branch}`, "--", branch], {
        write: true,
        ...at,
      });
  }
  return { branch };
}

async function bundleBranch(
  repository: Repository,
  input: BundleCloneOptions,
  heads: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  const listed = await repository.cli.call(input.path, ["bundle", "list-heads", input.bundle], {
    directoryFd: input.directoryFd,
  });
  const head = textOutput(listed)
    .split("\n")
    .map((line) => line.split(" "))
    .find(([, name]) => name === "HEAD")?.[0];
  const names = [...heads.keys()].map((ref) => ref.slice("refs/heads/".length));
  const atHead = names.filter(
    (name) => head !== undefined && heads.get(`refs/heads/${name}`) === head,
  );
  for (const pool of [atHead, names]) {
    const preferred = ["main", "master"].find((name) => pool.includes(name)) ?? pool[0];
    if (preferred !== undefined) return preferred;
  }
  return undefined;
}
