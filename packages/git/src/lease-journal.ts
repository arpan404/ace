import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MutationLease, type CleanupResult } from "@ace/provider-kit/cleanup";
import { GitError } from "./types.ts";

export interface OwnedLease {
  record: MutationLease;
  file: string;
  quarantined: boolean;
  cleanups: Promise<CleanupResult>[];
  released: Promise<void>;
  release(): void;
  /** The operation has unwound; only its killed processes can still keep the lease. */
  done: boolean;
  /**
   * Process groups of this lease's killed Git processes, when ace itself killed them and no
   * cleanup supervisor owns the proof. Once each group is gone the lease retires itself.
   * `undefined`: some cleanup belongs to a supervisor, so only its receipt can retire the lease.
   */
  groups: number[] | undefined;
}
/** Process-local I/O ownership registry, shared across service instances. */
export const live = new Map<string, OwnedLease>();
/**
 * Quarantined leases whose operation unwound while a killed process may still run. Kept here,
 * not forgotten, so this daemon can retire them as soon as their process groups are gone.
 */
export const orphans = new Map<string, OwnedLease>();
/** The lease this process owns under `id`: running, unwinding or orphaned. */
export const owned = (id: string) => live.get(id) ?? orphans.get(id);

export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
const metadataLimit = 1_100_000;
export async function text(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size > metadataLimit)
      throw new GitError("git_quarantined", "Git ownership metadata exceeds limit");
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > size)
      throw new GitError("git_quarantined", "Git ownership metadata changed while reading");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}
export async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Node cannot flush directory handles on Windows. File contents are flushed;
    // surviving intents still fail closed after process/daemon restart.
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EPERM", "EISDIR", "EINVAL"].includes(String(error.code))
    )
      return;
    throw error;
  }
}

/** A checkout's `.git` entry: its own metadata directory, or the one a `.git` file names. */
export async function metadataDirectory(root: string): Promise<string | undefined> {
  const dot = join(root, ".git");
  try {
    const info = await lstat(dot);
    if (info.isDirectory()) return dot;
    if (!info.isFile()) throw new GitError("git_quarantined", "Unsafe Git ownership directory");
    const contents = await text(dot);
    const match =
      contents && !contents.includes("\0")
        ? /^gitdir: ([\s\S]+)$/.exec(contents.replace(/\n$/, ""))
        : null;
    if (!match?.[1]) throw new GitError("git_quarantined", "Invalid Git ownership directory");
    return resolve(root, match[1]);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}

/** Resolve .git files and linked-worktree common directories without launching Git. */
export async function journal(root: string): Promise<string | undefined> {
  let metadata = await metadataDirectory(root);
  if (!metadata) return;
  const common = await text(join(metadata, "commondir"));
  if (common) metadata = resolve(metadata, common.replace(/\n$/, ""));
  return join(await realpath(metadata), "ace-mutation-leases");
}

export async function scopeJournal(root: string): Promise<string> {
  // A new repository owns its destination, even when created inside another repository.
  return (await journal(root)) ?? standaloneJournal(root);
}
function standaloneJournal(root: string): string {
  return join(
    dirname(root),
    ".ace-git-mutation-leases",
    createHash("sha256").update(root).digest("hex"),
  );
}
async function journals(path: string): Promise<string[]> {
  const result = new Set<string>();
  let root = await realpath(path);
  for (;;) {
    const directory = await journal(root);
    if (directory) result.add(directory);
    result.add(standaloneJournal(root));
    const parent = dirname(root);
    if (parent === root) return [...result];
    root = parent;
  }
}

/** Reads of a lease another process may still be writing before it counts as invalid. */
const leaseReads = 5;

/**
 * One journal lease, or undefined once it is gone. A lease an older daemon is still writing in
 * place reads empty, partial or growing for a moment; only one that stays unreadable is
 * invalid, and fences the checkout.
 */
async function leaseRecord(file: string, name: string): Promise<MutationLease | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      const content = await text(file);
      if (content === undefined) return undefined;
      const record = MutationLease.parse(JSON.parse(content));
      if (name !== record.id) throw new Error("lease identity mismatch");
      return record;
    } catch {
      if (attempt >= leaseReads)
        throw new GitError("git_quarantined", "Invalid Git ownership journal", { file });
      await new Promise((wake) => setTimeout(wake, 20 * attempt));
    }
  }
}

export interface JournalEntry {
  record: MutationLease;
  file: string;
}
/** Every durable intent in the journals that can fence `path`: its own and its ancestors'. */
export async function records(path: string): Promise<JournalEntry[]> {
  const result: JournalEntry[] = [];
  for (const directory of await journals(path)) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    // A lease being written (or left half-written by a crash) is staged under `.next`; only
    // published leases fence Git or count toward the journal's limit.
    const published = names.filter((name) => !name.endsWith(".next"));
    if (published.length > 256)
      throw new GitError("git_quarantined", "Git ownership journal exceeds limit");
    for (const name of published) {
      const file = join(directory, name);
      const running = owned(name);
      if (running) {
        result.push({ record: running.record, file });
        continue;
      }
      const record = await leaseRecord(file, name);
      if (record) result.push({ record, file });
    }
  }
  return result;
}
