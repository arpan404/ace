import { realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { decode, nul, pathAncestors, pathSchema } from "./decode.ts";
import { parseIndex, parseTree, type IndexEntry } from "./parse-index.ts";
import type { Repository } from "./repository.ts";
import { textOutput } from "./cli.ts";
import { transferTree } from "./object-transfer.ts";
import { serial } from "./lock.ts";
import { removeIndexSubtrees } from "./temporary-index.ts";
import { GitError } from "./types.ts";

export async function nestedPaths(
  repository: Repository,
  root: string,
  tracked: IndexEntry[],
  env: Record<string, string> = {},
): Promise<string[]> {
  const paths = new Set(tracked.filter((e) => e.mode === "160000").map((e) => e.path));
  for (const entry of tracked) {
    for (const ancestor of pathAncestors(entry.path).slice(0, -1)) paths.add(ancestor);
  }
  const untracked = nul(
    (
      await repository.cli.call(
        root,
        ["ls-files", "--others", "--modified", "--exclude-standard", "-z"],
        { env },
      )
    ).stdout,
  );
  for (const record of untracked) {
    const path = decode(
      pathSchema,
      record.endsWith("/") ? record.slice(0, -1) : record,
      "untracked path",
    );
    paths.add(path);
    const directory = record.endsWith("/")
      ? path
      : path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (directory) for (const ancestor of pathAncestors(directory)) paths.add(ancestor);
  }
  return repositoryPaths(root, paths);
}

export async function repositoryPaths(root: string, paths: Iterable<string>): Promise<string[]> {
  const candidates = [...paths];
  const nested: string[] = [];
  // Metadata checks are independent. Bound their concurrency instead of waiting
  // for one filesystem round trip per candidate in a large working tree.
  for (let start = 0; start < candidates.length; start += 64) {
    const roots = await Promise.all(
      candidates.slice(start, start + 64).map(async (path) => {
        try {
          await stat(join(root, path, ".git"));
          return path;
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ENOTDIR")
            )
          )
            throw error;
          return undefined;
        }
      }),
    );
    for (const path of roots) if (path !== undefined) nested.push(path);
  }
  // A repository owns discovery below its root. Returning deeper roots here
  // would snapshot them twice and acquire their locks out of hierarchy order.
  const roots = new Set(nested);
  return nested.toSorted().filter(
    (path) =>
      !pathAncestors(path)
        .slice(0, -1)
        .some((p) => roots.has(p)),
  );
}

export async function nestedRoot(
  repository: Repository,
  root: string,
  path: string,
): Promise<string> {
  const nested = await realpath(join(root, path));
  if (textOutput(await repository.cli.call(nested, ["rev-parse", "--show-prefix"])) !== "")
    throw new GitError("not_a_repo", "Nested path is not a repository root");
  if (relative(root, nested).split(sep).join("/") !== path)
    throw new GitError(
      "unsupported_repository",
      "Nested repository must have its own working root",
    );
  return nested;
}

export async function flattenNested(
  repository: Repository,
  root: string,
  paths: string[],
  env: Record<string, string>,
  snapshot: (repository: Repository, root: string) => Promise<string>,
  heldRoots: ReadonlySet<string>,
): Promise<void> {
  await removeIndexSubtrees(repository, root, paths, env);
  for (const path of paths) {
    const nested = await nestedRoot(repository, root, path);
    const capture = async () => {
      const tree = await snapshot(repository, nested);
      await transferTree(repository, nested, root, tree);
      const entries = parseTree(
        (await repository.cli.call(root, ["ls-tree", "-r", "-z", tree])).stdout,
      );
      const input =
        `0 ${"0".repeat(tree.length)}\t${path}\0` +
        entries.map((e) => `${e.mode} ${e.sha} 0\t${path}/${e.path}\0`).join("");
      await repository.cli.call(root, ["update-index", "-z", "--index-info"], {
        write: true,
        env,
        input,
      });
    };
    if (heldRoots.has(nested)) await capture();
    else await serial(nested, capture);
  }
}

export async function ignoredPaths(
  repository: Repository,
  root: string,
  env: Record<string, string> = {},
): Promise<string[]> {
  const ignored = nul(
    (
      await repository.cli.call(
        root,
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        { env },
      )
    ).stdout,
  ).map((p) => decode(pathSchema, p, "ignored path"));
  const tracked = parseIndex(
    (await repository.cli.call(root, ["ls-files", "--stage", "-z"])).stdout,
  );
  for (const path of await nestedPaths(repository, root, tracked)) {
    // Administrative data is excluded from snapshots and must never be replaced.
    ignored.push(`${path}/.git`);
    for (const child of await ignoredPaths(repository, join(root, path)))
      ignored.push(`${path}/${child}`);
  }
  return ignored;
}
