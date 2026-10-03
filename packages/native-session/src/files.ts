import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export async function safeOpen(home: string, path: string) {
  if (!contains(home, path)) throw new Error("Session path escaped its registered home");
  const [canonicalHome, canonicalPath] = await Promise.all([realpath(home), realpath(path)]);
  if (!contains(canonicalHome, canonicalPath))
    throw new Error("Session path escaped its registered home");
  const parts = relative(home, path).split(sep).filter(Boolean);
  if (parts.length > 32) throw new Error("Session path depth limit exceeded");
  let current = home;
  const parents: string[] = [];
  for (const part of parts) {
    current = join(current, part);
    parents.push(current);
  }
  const checked = await Promise.allSettled(parents.map((parent) => lstat(parent)));
  for (const result of checked) {
    if (result.status === "rejected") throw result.reason;
    if (result.value.isSymbolicLink()) throw new Error("Session path contains a symlink");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!(await file.stat()).isFile()) {
    await file.close();
    throw new Error("Session source is not a regular file");
  }
  return file;
}
export async function* walkFiles(
  root: string,
  signal?: AbortSignal,
  budget = { entries: 0 },
  depth = 0,
): AsyncGenerator<string> {
  signal?.throwIfAborted();
  if (depth > 16) throw new Error("Session directory depth limit exceeded");
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Session directory is not a real directory");
  for await (const entry of await opendir(root)) {
    signal?.throwIfAborted();
    if (++budget.entries > 100_000) throw new Error("Session inventory limit exceeded");
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path, signal, budget, depth + 1);
    else if (entry.isFile()) yield path;
    // Symlinks and special files are never followed.
  }
}
export function fingerprint(info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
export async function readHeadTail(home: string, path: string, signal?: AbortSignal) {
  const file = await safeOpen(home, path);
  try {
    signal?.throwIfAborted();
    const before = await file.stat();
    const size = before.size;
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    const tailStart = Math.max(head.length, size - 64 * 1024);
    const tail = Buffer.alloc(size - tailStart);
    await file.read(head, 0, head.length, 0);
    if (tail.length) await file.read(tail, 0, tail.length, tailStart);
    if (fingerprint(before) !== fingerprint(await file.stat()))
      throw new Error("Session changed while sampling");
    signal?.throwIfAborted();
    // When the two windows meet, decode as one so a crossing line is not lost.
    const windows =
      tailStart === head.length
        ? [Buffer.concat([head, tail])]
        : [head, tail.subarray(Math.max(0, tail.indexOf(10) + 1))];
    const records: unknown[] = [];
    let decodeFailed = false;
    for (const bytes of windows) {
      for (const line of bytes.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          decodeFailed = true;
        }
      }
    }
    if (records.length === 0 && size <= 128 * 1024) {
      try {
        records.push(JSON.parse(Buffer.concat([head, tail]).toString("utf8")));
        decodeFailed = false;
      } catch {
        /* malformed source */
      }
    }
    return {
      records,
      exact: size <= 128 * 1024 && !decodeFailed,
      bytes: head.length + tail.length,
      fingerprint: fingerprint(before),
      mtime: Math.floor(before.mtimeMs),
    };
  } finally {
    await file.close();
  }
}
