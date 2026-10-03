import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseIndex } from "./parse-index.ts";
import { Repository } from "./repository.ts";
import { pathAncestors } from "./decode.ts";

export async function withIndex<T>(
  directoryRoot: string,
  operation: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(directoryRoot, "ace-git-index-"));
  try {
    return await operation({ GIT_INDEX_FILE: join(directory, "index") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function removeIndexSubtrees(
  repository: Repository,
  root: string,
  paths: string[],
  env: Record<string, string>,
): Promise<void> {
  if (!paths.length) return;
  const roots = new Set(paths);
  const entries = parseIndex(
    (await repository.cli.call(root, ["ls-files", "--stage", "-z"], { env })).stdout,
  );
  const remove = entries.filter((entry) =>
    pathAncestors(entry.path).some((path) => roots.has(path)),
  );
  if (remove.length)
    await repository.cli.call(root, ["update-index", "--force-remove", "-z", "--stdin"], {
      write: true,
      env,
      input: remove.map((entry) => entry.path).join("\0") + "\0",
    });
}
export async function statusWithoutHidingFlags(repository: Repository, root: string) {
  const entries = parseIndex(
    (await repository.cli.call(root, ["ls-files", "--stage", "-z"])).stdout,
  );
  return withIndex(repository.tempDirectory, async (env) => {
    await repository.cli.call(root, ["read-tree", "--empty"], { write: true, env });
    const seed = entries
      .map((entry) => `${entry.mode} ${entry.sha} ${entry.stage}\t${entry.path}\0`)
      .join("");
    await repository.cli.call(root, ["update-index", "-z", "--index-info"], {
      write: true,
      env,
      input: seed,
    });
    return (await repository.state(root, env)).status;
  });
}
