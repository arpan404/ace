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
 * How far a lock's recorded mtime and a process's estimated start may each be off. Filesystems
 * store mtimes as coarsely as 2 seconds (FAT), so a lock written at 103.8 s can read 102 s; the
 * start estimate has up to a second of rounding; clocks jitter. Within this much of the lock's
 * stamp, a process may still be its writer.
 */
export const timestampSlackMs = 5000;

/**
 * Whether `process` may hold a lock stamped `written`. Git creates a lock exclusively, so a
 * process that started clearly after the lock was written can't be the one holding it: a reader
 * an agent started a while later never keeps a dead writer's lock alive. When the timestamps
 * can't rule it out, the process counts as the writer.
 */
const mayHold = (process: GitProcess, written: Date) =>
  process.startedAt === undefined || process.startedAt <= written.getTime() + timestampSlackMs;

/** Whether `file` is a plain file last written before `before`: a lock that may be stale. */
async function writtenBefore(file: string, before: Date): Promise<boolean> {
  try {
    const info = await lstat(file);
    return info.isFile() && info.mtime < before;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

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

/** The repository's shared metadata directory for `checkout`, canonical; undefined if none. */
export async function gitCommonDirectory(checkout: string): Promise<string | undefined> {
  const metadata = await metadataDirectory(checkout).catch(() => undefined);
  if (!metadata) return;
  const common = await canonical(metadata);
  const shared = await text(join(common, "commondir")).catch(() => undefined);
  return shared ? canonical(resolve(common, shared.replace(/\n$/, ""))) : common;
}

/** A lock file and the checkouts whose Git processes may hold it. */
interface Candidate {
  file: string;
  roots: readonly string[];
}

/** Every Git lock file in the repository at `common` that a dead process may have left. */
async function candidates(common: string, all: readonly Checkout[]): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const entry of all) {
    if (!entry.path) continue;
    const roots = [entry.path];
    found.push({ file: join(entry.metadata, "index.lock"), roots });
    found.push({ file: join(entry.metadata, "HEAD.lock"), roots });
    // A partial commit's temporary index, named after the Git process that wrote it.
    const names = await readdir(entry.metadata).catch(() => []);
    for (const name of names.filter((n) => /^next-index-\d+\.lock$/.test(n)))
      found.push({ file: join(entry.metadata, name), roots });
  }
  const everywhere = [common, ...all.flatMap((entry) => (entry.path ? [entry.path] : []))];
  for (const name of ["packed-refs.lock", "shallow.lock", "config.lock"])
    found.push({ file: join(common, name), roots: everywhere });
  const refs: string[] = [];
  await refLocks(join(common, "refs"), refs);
  for (const file of refs) found.push({ file, roots: everywhere });
  for (const entry of all) {
    if (!entry.linked) continue;
    // `worktree add` writes "initializing" while it runs; a person's own lock has their reason.
    const file = join(entry.metadata, "locked");
    if ((await text(file).catch(() => undefined))?.trim() === "initializing")
      found.push({ file, roots: everywhere });
  }
  return found;
}

/**
 * Git's own lock files that a killed or crashed Git process left behind in the repository that
 * owns `checkout`: each checkout's `index.lock` and `HEAD.lock`, the shared ref, packed-refs,
 * shallow and config locks, and a `worktree add` that never finished initializing.
 *
 * A lock is removed only when it was last written before `before` and every live Git process
 * working in what it guards started after that write, so neither a running writer nor a Git
 * command someone starts meanwhile loses its lock. Without a process listing nothing is
 * removed, and with no lock old enough to remove, no listing is taken. `scan` must list
 * processes as they are after `before`. Returns the removed paths.
 */
export async function clearLeftoverLocks(
  checkout: string,
  scan: GitProcessScan,
  before: Date,
): Promise<string[]> {
  const common = await gitCommonDirectory(checkout);
  if (!common) return [];
  const all = await checkouts(common);
  const stale: Candidate[] = [];
  for (const candidate of await candidates(common, all))
    if (await writtenBefore(candidate.file, before)) stale.push(candidate);
  if (!stale.length) return [];
  const processes = await scan();
  if (!processes) return [];
  const removed: string[] = [];
  for (const { file, roots } of stale)
    if (await removeStale(file, before, working(processes, roots))) removed.push(file);
  return removed;
}
