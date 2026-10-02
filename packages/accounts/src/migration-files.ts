import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { opendir, lstat, mkdir, open, link, unlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

export class MigrationFailure extends Error {
  status: "unsupported" | "refused";
  constructor(status: "unsupported" | "refused", reason: string) {
    super(reason);
    this.status = status;
  }
}
export async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
/** No recursion through symlinks, bounded directory depth and total entries. */
export async function* walkFiles(
  root: string,
  budget: { entries: number } = { entries: 0 },
  depth = 0,
): AsyncGenerator<string> {
  if (depth > 16) throw new MigrationFailure("refused", "Directory depth limit exceeded");
  if (!(await exists(root))) return;
  if (!(await lstat(root)).isDirectory())
    throw new MigrationFailure("refused", "Expected a real directory");
  const dir = await opendir(root);
  for await (const entry of dir) {
    if (++budget.entries > 20_000)
      throw new MigrationFailure("refused", "Session inventory limit exceeded");
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path, budget, depth + 1);
    else if (entry.isFile()) yield path;
    else throw new MigrationFailure("refused", "Symlinks and special files cannot be migrated");
  }
}
export async function firstLine(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < 256 * 1024) {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      const bytes = buffer.subarray(0, bytesRead);
      const newline = bytes.indexOf(10);
      chunks.push(newline < 0 ? bytes : bytes.subarray(0, newline));
      if (newline >= 0 || bytesRead < buffer.length) return Buffer.concat(chunks).toString("utf8");
      position += bytesRead;
    }
    throw new MigrationFailure("unsupported", "Session metadata exceeds limit");
  } finally {
    await file.close();
  }
}
export type CopyFile = { source: string; relative: string };
export function fingerprint(stat: Awaited<ReturnType<typeof lstat>>): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
export async function stageFile(file: CopyFile, stage: string) {
  const source = await open(file.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new MigrationFailure("refused", "Source is not a regular file");
    const target = join(stage, file.relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await pipeline(
      source.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    if (fingerprint(before) !== fingerprint(await source.stat()))
      throw new MigrationFailure("refused", "Source changed during copy");
    return fingerprint(before);
  } finally {
    await source.close();
  }
}
export function contains(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export async function safeParents(home: string, target: string) {
  if (!contains(home, target))
    throw new MigrationFailure("refused", "Destination path escaped its home");
  const parts = relative(home, dirname(target)).split(sep).filter(Boolean);
  let current = home;
  for (const part of parts) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !contains(home, await realpath(current)))
      throw new MigrationFailure("refused", "Destination contains a symlink");
  }
}
export async function publishFile(stage: string, home: string, file: CopyFile) {
  const target = join(home, file.relative);
  await safeParents(home, target);
  // A hard link is an atomic no-clobber publish on this same filesystem.
  await link(join(stage, file.relative), target);
  return target;
}
export async function rollback(paths: readonly string[]) {
  for (const path of paths.toReversed()) await unlink(path);
}

export async function digestFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile())
      throw new MigrationFailure("refused", "Session copy is not a regular file");
    const digest = createHash("sha256");
    await pipeline(file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }), digest);
    if (fingerprint(before) !== fingerprint(await file.stat()))
      throw new MigrationFailure("refused", "Session changed during verification");
    return { hash: digest.digest("hex"), fingerprint: fingerprint(before) };
  } finally {
    await file.close();
  }
}

/** Resolve a not-yet-created destination without writing into a source alias. */
export async function canonicalDestination(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!(await exists(ancestor))) {
    if (missing.length >= 128)
      throw new MigrationFailure("refused", "Destination depth limit exceeded");
    missing.push(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new MigrationFailure("refused", "Destination root does not exist");
    ancestor = parent;
  }
  return join(await realpath(ancestor), ...missing.toReversed());
}
