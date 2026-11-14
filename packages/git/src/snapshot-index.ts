import { copyFile, readdir, stat, utimes } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { textOutput } from "./cli.ts";
import { decode, hash, malformed, nul, pathAncestors } from "./decode.ts";
import { parseIndex, type IndexEntry } from "./parse-index.ts";
import type { Repository } from "./repository.ts";
import { withIndex } from "./temporary-index.ts";
import { GitError } from "./types.ts";

// Snapshot capture and restore discovery must see the same HEAD/index union,
// including HEAD paths staged for deletion and now hidden by ignore rules.
export async function withSnapshotIndex<T>(
  repository: Repository,
  root: string,
  operation: (env: Record<string, string>, seeded: IndexEntry[]) => Promise<T>,
): Promise<T> {
  const { cli } = repository;
  const [sparse, index] = await Promise.all([
    cli.configFact(root, "sparse-checkout", () => sparseCheckout(repository, root)),
    cli.configFact(root, "index-path", async () =>
      resolve(root, textOutput(await cli.call(root, ["rev-parse", "--git-path", "index"]))),
    ),
  ]);
  if (sparse)
    throw new GitError(
      "unsupported_repository",
      "Full working-tree snapshots do not support sparse checkout",
    );
  return withIndex(repository.tempDirectory, async (env) => {
    const [head, copied] = await Promise.all([
      cli.call(root, ["rev-parse", "--verify", "HEAD^{tree}"], { allowFailure: true }),
      copyIndex(repository, root, index, env),
    ]);
    const tree = head.exitCode === 0 ? hash(textOutput(head)) : undefined;
    const seeded = copied
      ? await addHeadPaths(repository, root, env, copied, tree)
      : await seedFromScratch(repository, root, env, tree);
    // Windows: a snapshot only records the checkout. A person's core.safecrlf=true must not
    // refuse a file whose line endings Git would not round-trip.
    if (cli.platform === "win32")
      return operation({ ...env, GIT_CONFIG_PARAMETERS: "'core.safecrlf'='false'" }, seeded);
    return operation(env, seeded);
  });
}

async function sparseCheckout(repository: Repository, root: string): Promise<boolean> {
  const sparse = await repository.cli.call(
    root,
    ["config", "--type=bool", "--get", "core.sparseCheckout"],
    { allowFailure: true },
  );
  if (sparse.exitCode !== 0 && sparse.exitCode !== 1)
    throw new GitError("git_failed", sparse.stderr);
  return (
    sparse.exitCode === 0 &&
    decode(z.enum(["true", "false"]), textOutput(sparse), "sparse checkout config") === "true"
  );
}

/**
 * Seed the temporary index with a byte copy of the checkout's own index, so `git add` reuses
 * its stat data instead of hashing every file again. The checkout's index is only read.
 * Returns undefined when the copy cannot stand in for the real index; the caller then builds
 * the temporary index from scratch.
 */
async function copyIndex(
  repository: Repository,
  root: string,
  index: string,
  env: Record<string, string>,
): Promise<IndexEntry[] | undefined> {
  const target = env.GIT_INDEX_FILE;
  if (!target) return undefined;
  // A split index refers to shared files beside it; writing the copy could add new ones there.
  try {
    if ((await readdir(dirname(index))).some((name) => name.startsWith("sharedindex.")))
      return undefined;
    const source = await stat(index);
    // Git renames a finished index into place, so this reads one complete version of it.
    await copyFile(index, target);
    // Git rechecks entries changed at or after the index's own timestamp ("racily clean").
    // The copy keeps a timestamp no later than the original's, so that window only widens.
    const seconds = Math.floor(source.mtimeMs / 1000) - 1;
    await utimes(target, seconds, seconds);
  } catch {
    return undefined;
  }
  const listing = await repository.cli.call(root, ["ls-files", "-v", "--stage", "-z"], {
    env,
    allowFailure: true,
  });
  if (listing.exitCode !== 0) return undefined;
  const assumed: string[] = [];
  const skipped: string[] = [];
  // `<tag> <mode> <sha> <stage>\t<path>`: lowercase tags are assume-unchanged, S skip-worktree.
  const records = nul(listing.stdout);
  if (records.some((record) => record[1] !== " ")) throw malformed("index tag");
  const entries = records.length
    ? parseIndex(Buffer.from(records.map((record) => record.slice(2)).join("\0") + "\0"))
    : [];
  for (const [position, entry] of entries.entries()) {
    const tag = records[position]?.[0] ?? "";
    if (tag === "S") skipped.push(entry.path);
    else if (tag !== tag.toUpperCase()) assumed.push(entry.path);
  }
  // A conflicted index keeps several stages per path; the from-scratch seed flattens those.
  if (entries.some((entry) => entry.stage !== "0")) return undefined;
  // Hidden-change flags would let `git add` skip a path's real content, so clear them.
  // update-index applies only the first flag option given to each path: one call per flag.
  for (const [flag, paths] of [
    ["--no-assume-unchanged", assumed],
    ["--no-skip-worktree", skipped],
  ] as const)
    if (paths.length)
      await repository.cli.call(root, ["update-index", flag, "-z", "--stdin"], {
        write: true,
        env,
        input: paths.join("\0") + "\0",
      });
  return entries;
}

/** Add HEAD's paths the index no longer has; the index's own entries win any overlap. */
async function addHeadPaths(
  repository: Repository,
  root: string,
  env: Record<string, string>,
  entries: IndexEntry[],
  tree: string | undefined,
): Promise<IndexEntry[]> {
  if (!tree) return entries;
  const { cli } = repository;
  const removed = parseRemoved(
    (
      await cli.call(
        root,
        ["diff-index", "--cached", "--raw", "--no-renames", "--diff-filter=D", "-z", tree],
        { env },
      )
    ).stdout,
  );
  if (!removed.length) return entries;
  const files = new Set(entries.map((entry) => entry.path));
  const directories = new Set(entries.flatMap((entry) => pathAncestors(entry.path).slice(0, -1)));
  const missing = removed.filter(
    (entry) =>
      !directories.has(entry.path) &&
      !pathAncestors(entry.path).some((ancestor) => files.has(ancestor)),
  );
  if (!missing.length) return entries;
  const input = missing.map((entry) => `${entry.mode} ${entry.sha} 0\t${entry.path}\0`).join("");
  await cli.call(root, ["update-index", "-z", "--index-info"], { write: true, env, input });
  return parseIndex((await cli.call(root, ["ls-files", "--stage", "-z"], { env })).stdout);
}

/** `:<mode> 000000 <sha> <zero> D` then the path, for each HEAD path absent from the index. */
function parseRemoved(buffer: Buffer): IndexEntry[] {
  const records = nul(buffer);
  if (records.length % 2) throw malformed("diff-index record arity");
  const removed: IndexEntry[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const [mode, , sha] = (records[index] ?? "").slice(1).split(" ");
    const path = records[index + 1] ?? "";
    const [entry] = parseIndex(Buffer.from(`${mode} ${sha} 0\t${path}\0`));
    if (!entry) throw malformed("diff-index record");
    removed.push(entry);
  }
  return removed;
}

/** The temporary index as HEAD overlaid with every path the checkout's index tracks. */
async function seedFromScratch(
  repository: Repository,
  root: string,
  env: Record<string, string>,
  tree: string | undefined,
): Promise<IndexEntry[]> {
  const { cli } = repository;
  await cli.call(root, ["read-tree", ...(tree ? [tree] : ["--empty"])], { write: true, env });
  const tracked = parseIndex((await cli.call(root, ["ls-files", "--stage", "-z"])).stdout);
  const seed = tracked.map((entry) => `${entry.mode} ${entry.sha} 0\t${entry.path}\0`).join("");
  await cli.call(root, ["update-index", "-z", "--index-info"], { write: true, env, input: seed });
  return parseIndex((await cli.call(root, ["ls-files", "--stage", "-z"], { env })).stdout);
}
