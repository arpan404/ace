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
}
/** Process-local I/O ownership registry, shared across service instances. */
export const live = new Map<string, OwnedLease>();

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

/** Nearest repository's shared ownership key, including linked worktrees, without Git I/O.
 * Non-repository working directories retain their own standalone ownership key. */
export async function repositoryScope(path: string): Promise<string> {
  const original = await realpath(path);
  let root = original;
  for (;;) {
    const key = await journal(root);
    if (key) return key;
    const parent = dirname(root);
    if (parent === root) return standaloneJournal(original);
    root = parent;
  }
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
    if (names.length > 256)
      throw new GitError("git_quarantined", "Git ownership journal exceeds limit");
    for (const name of names) {
      const file = join(directory, name);
      if (name.endsWith(".next")) continue;
      const running = live.get(name);
      if (running) {
        result.push({ record: running.record, file });
        continue;
      }
      const content = await text(file);
      if (content === undefined) continue;
      try {
        const record = MutationLease.parse(JSON.parse(content));
        if (name !== record.id) throw new Error("lease identity mismatch");
        result.push({ record, file });
      } catch {
        throw new GitError("git_quarantined", "Invalid Git ownership journal", { file });
      }
    }
  }
  return result;
}
