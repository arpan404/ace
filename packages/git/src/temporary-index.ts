import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseIndex } from "./parse-index.ts";
import { Repository } from "./repository.ts";
import { pathAncestors } from "./decode.ts";

/**
 * Command-scope settings for every Git call on a temporary index (checkpoint capture, restore,
 * their discovery and collision checks). fsmonitor and the untracked cache could answer for
 * files without Git looking at them, and `core.ignoreStat` marks every entry `read-tree` or
 * `add` writes as assume-unchanged, so a later edit to it is skipped.
 */
const temporaryIndexSettings: readonly (readonly [string, string])[] = [
  ["core.fsmonitor", "false"],
  ["core.untrackedCache", "false"],
  ["core.ignoreStat", "false"],
];

/** `GIT_CONFIG_PARAMETERS` quoting: single quotes, with any quote inside escaped. */
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** `env` with one more command-scope setting after the ones it already carries. */
export function withSetting(
  env: Record<string, string>,
  key: string,
  value: string,
): Record<string, string> {
  const setting = `${quoted(key)}=${quoted(value)}`;
  const current = env.GIT_CONFIG_PARAMETERS;
  return { ...env, GIT_CONFIG_PARAMETERS: current ? `${current} ${setting}` : setting };
}

export async function withIndex<T>(
  directoryRoot: string,
  operation: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(directoryRoot, "ace-git-index-"));
  try {
    let env: Record<string, string> = { GIT_INDEX_FILE: join(directory, "index") };
    for (const [key, value] of temporaryIndexSettings) env = withSetting(env, key, value);
    return await operation(env);
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
