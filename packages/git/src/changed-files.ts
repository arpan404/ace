import { open } from "node:fs/promises";
import { join } from "node:path";
import { serial } from "./lock.ts";
import type { Repository } from "./repository.ts";
import type { ChangedFile, StatusEntry } from "./types.ts";

const kinds: Record<string, ChangedFile["status"]> = {
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "added",
};

/** What one status entry amounts to against HEAD, from its index and worktree letters. */
function kindOf(entry: StatusEntry): ChangedFile["status"] {
  if (entry.oldPath) return "renamed";
  for (const letter of [entry.worktreeStatus, entry.indexStatus])
    if (letter === "D") return "deleted";
  return kinds[entry.indexStatus] ?? "modified";
}

/** Untracked files are counted from their first bytes only: larger ones count as unknown. */
const untrackedBytes = 1024 * 1024;
/** Pathspec bytes per `git diff` call, well inside every platform's argument limit. */
const pathspecBytes = 64 * 1024;

/** `git diff --numstat -z` records: "a\td\tpath", or "a\td\t" then old and new paths. */
type Counted = { added: number; deleted: number; binary: boolean };

function parseNumstat(stdout: Buffer, into: Map<string, Counted>) {
  const records = stdout.toString("utf8").split("\0");
  for (let at = 0; at < records.length; at++) {
    const record = records[at];
    if (!record) continue;
    const [added = "", deleted = "", path = ""] = record.split("\t");
    // Renames put both paths in the next two records; the new path is the file's.
    const file = path || records[(at += 2)];
    if (!file) continue;
    // "-" marks a binary file: lines don't apply.
    into.set(file, {
      added: Number(added) || 0,
      deleted: Number(deleted) || 0,
      binary: added === "-",
    });
  }
}

/** Line counts of tracked files against HEAD, read without writing any object. */
async function trackedCounts(repository: Repository, root: string, paths: readonly string[]) {
  const counts = new Map<string, Counted>();
  const batches: string[][] = [[]];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (bytes + size > pathspecBytes && batches.at(-1)?.length) {
      batches.push([]);
      bytes = 0;
    }
    batches.at(-1)?.push(path);
    bytes += size;
  }
  for (const batch of batches) {
    if (!batch.length) continue;
    const { stdout } = await repository.cli.call(
      root,
      ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M", "HEAD", "--", ...batch],
      { env: { GIT_LITERAL_PATHSPECS: "1" } },
    );
    parseNumstat(stdout, counts);
  }
  return counts;
}

/** An untracked file's lines, from its first bytes; unknown (zero) past the cap. */
async function untrackedCount(root: string, path: string) {
  try {
    const file = await open(join(root, path), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > untrackedBytes) return { added: 0, binary: false };
      const buffer = Buffer.alloc(stat.size);
      await file.read(buffer, 0, stat.size, 0);
      if (buffer.includes(0)) return { added: 0, binary: true };
      let lines = 0;
      for (const byte of buffer) if (byte === 10) lines++;
      if (buffer.length && buffer.at(-1) !== 10) lines++;
      return { added: lines, binary: false };
    } finally {
      await file.close();
    }
  } catch {
    return { added: 0, binary: false };
  }
}

/**
 * Exactly the files `git status` reports (staged, unstaged, conflicted and untracked, ignored
 * files excluded), sorted by path and capped at `limit`, each with its lines changed against
 * HEAD. A read: no object, index or snapshot is written, and only the listed files are diffed
 * or read (untracked ones up to 1 MiB).
 */
export async function changedFiles(
  repository: Repository,
  worktree: string,
  limit: number,
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const root = await repository.root(worktree);
  return serial(root, async () => {
    const { status, branch } = await repository.state(root);
    const files = new Map<string, ChangedFile>();
    const add = (path: string, kind: ChangedFile["status"], from?: string) => {
      if (files.has(path)) return;
      files.set(path, {
        path,
        ...(from ? { from } : {}),
        status: kind,
        additions: 0,
        deletions: 0,
        binary: false,
      });
    };
    for (const entry of [...status.conflicted, ...status.staged, ...status.unstaged])
      add(entry.path, kindOf(entry), entry.oldPath);
    for (const path of status.untracked) add(path, "untracked");
    const sorted = [...files.values()].toSorted((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const listed = sorted.slice(0, limit);
    const tracked = listed.filter((file) => file.status !== "untracked");
    const counts = branch.head
      ? await trackedCounts(
          repository,
          root,
          tracked.flatMap((file) => (file.from ? [file.path, file.from] : [file.path])),
        )
      : new Map<string, Counted>();
    for (const file of tracked) {
      const counted = counts.get(file.path);
      if (counted) {
        file.additions = counted.added;
        file.deletions = counted.deleted;
        file.binary = counted.binary;
      }
    }
    for (const file of listed)
      if (file.status === "untracked") {
        const counted = await untrackedCount(root, file.path);
        file.additions = counted.added;
        file.binary = counted.binary;
      }
    return { files: listed, truncated: sorted.length > limit };
  });
}
