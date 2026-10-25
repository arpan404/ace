import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { touches, type GitProcess, type GitProcessScan } from "./git-processes.ts";
import { metadataDirectory, missing, text } from "./lease-journal.ts";

/** A Git lock file younger than this may belong to a command that is just starting. */
export const lockGraceMs = 2000;

/** One checkout of a repository: its own metadata directory and, when it has one, its files. */
interface Checkout {
  metadata: string;
  path: string | undefined;
  linked: boolean;
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function checkouts(common: string): Promise<Checkout[]> {
  const result: Checkout[] = [
    {
      metadata: common,
      path: basename(common) === ".git" ? dirname(common) : undefined,
      linked: false,
    },
  ];
  const names = await readdir(join(common, "worktrees")).catch(() => []);
  for (const name of names.slice(0, 1024)) {
    const metadata = join(common, "worktrees", name);
    const back = await text(join(metadata, "gitdir")).catch(() => undefined);
    const path = back ? await canonical(dirname(resolve(metadata, back.trim()))) : undefined;
    result.push({ metadata, path, linked: true });
  }
  return result;
}

/** `refs/**\/*.lock`, bounded so a huge ref tree can't stall the caller. */
async function refLocks(directory: string, found: string[], depth = 0): Promise<void> {
  if (depth > 8 || found.length > 256) return;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await refLocks(path, found, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".lock")) found.push(path);
  }
}

/**
 * Whether `process` may hold a lock last written at `written`. Git creates a lock exclusively,
 * so a process that started after the lock was last written can't be the one holding it: a
 * reader an agent started a moment ago never keeps a dead writer's lock alive.
 */
const mayHold = (process: GitProcess, written: Date) =>
  process.startedAt === undefined || process.startedAt <= written.getTime();

/**
 * Removes `file` only if it is a plain file last written before `before` that none of the live
 * Git processes working where it guards could have written.
 */
async function removeStale(
  file: string,
  before: Date,
  holders: readonly GitProcess[],
): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.mtime >= before) return false;
    if (holders.some((entry) => mayHold(entry, info.mtime))) return false;
    await rm(file, { force: true });
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

const working = (processes: readonly GitProcess[], roots: readonly string[]) =>
  processes.filter((entry) => touches(entry, roots));

/**
 * Git's own lock files that a killed or crashed Git process left behind in the repository that
 * owns `checkout`: each checkout's `index.lock` and `HEAD.lock`, the shared ref, packed-refs,
 * shallow and config locks, and a `worktree add` that never finished initializing.
 *
 * A lock is removed only when it was last written before `before` and every live Git process
 * working in what it guards started after that write, so neither a running writer nor a Git
 * command someone starts meanwhile loses its lock. Without a process listing nothing is
 * removed. Returns the removed paths.
 */
export async function clearLeftoverLocks(
  checkout: string,
  scan: GitProcessScan,
  before: Date,
): Promise<string[]> {
  const metadata = await metadataDirectory(checkout).catch(() => undefined);
  if (!metadata) return [];
  let common = await canonical(metadata);
  const shared = await text(join(common, "commondir")).catch(() => undefined);
  if (shared) common = await canonical(resolve(common, shared.replace(/\n$/, "")));
  const processes = await scan();
  if (!processes) return [];
  const all = await checkouts(common);
  const removed: string[] = [];
  const clear = async (file: string, holders: readonly GitProcess[]) => {
    if (await removeStale(file, before, holders)) removed.push(file);
  };
  for (const entry of all) {
    if (!entry.path) continue;
    const holders = working(processes, [entry.path]);
    await clear(join(entry.metadata, "index.lock"), holders);
    await clear(join(entry.metadata, "HEAD.lock"), holders);
    // A partial commit's temporary index, named after the Git process that wrote it.
    const names = await readdir(entry.metadata).catch(() => []);
    for (const name of names.filter((n) => /^next-index-\d+\.lock$/.test(n)))
      await clear(join(entry.metadata, name), holders);
  }
  const everywhere = [common, ...all.flatMap((entry) => (entry.path ? [entry.path] : []))];
  const holders = working(processes, everywhere);
  for (const name of ["packed-refs.lock", "shallow.lock", "config.lock"])
    await clear(join(common, name), holders);
  const refs: string[] = [];
  await refLocks(join(common, "refs"), refs);
  for (const file of refs) await clear(file, holders);
  for (const entry of all) {
    if (!entry.linked) continue;
    // `worktree add` writes "initializing" while it runs; a person's own lock has their reason.
    const file = join(entry.metadata, "locked");
    if ((await text(file).catch(() => undefined))?.trim() === "initializing")
      await clear(file, holders);
  }
  return removed;
}
