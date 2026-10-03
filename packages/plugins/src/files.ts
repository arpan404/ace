import { createHash } from "node:crypto";

import { lstat, mkdir, opendir, realpath, writeFile, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { constants } from "node:fs";
import { limits, normalizePath } from "./manifest.ts";
import type { PackageFile } from "./types.ts";

export async function assertNoSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink forbidden: ${current}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
export async function assertTreeNoSymlinks(root: string): Promise<void> {
  let count = 0;
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 40 || ++count > limits.files * 8) throw new Error("Owned tree entry limit");
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Symlink forbidden: ${path}`);
    if (info.isDirectory())
      for await (const entry of await opendir(path)) await walk(join(path, entry.name), depth + 1);
  }
  try {
    await walk(root, 0);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
const marker = ".ace-plugins-owned";
export async function ownDirectory(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error("ace root must be absolute");
  await assertNoSymlinks(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const markerPath = join(root, marker);
  await assertNoSymlinks(markerPath);
  try {
    const handle = await open(
      markerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== 15) throw new Error("Invalid ownership marker");
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      if (bytesRead !== 15 || buffer.subarray(0, bytesRead).toString("utf8") !== "ace-plugins-v1\n")
        throw new Error("Invalid ownership marker");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    for await (const entry of await opendir(root))
      throw new Error(`Refusing to adopt a nonempty directory: ${entry.name}`, { cause: error });
    await writeFile(markerPath, "ace-plugins-v1\n", { flag: "wx", mode: 0o600 });
  }
  return realpath(root);
}
export async function hashFile(
  path: string,
  maximum = limits.file,
): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Special file forbidden");
    if (info.size > maximum) throw new Error("File exceeds byte limit");
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maximum) {
        stream.destroy();
        throw new Error("File exceeds byte limit");
      }
      hash.update(chunk);
    }
    return { hash: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}
export async function inspectPackage(
  root: string,
): Promise<{ files: PackageFile[]; hash: string }> {
  await assertNoSymlinks(root);
  const files: PackageFile[] = [];
  let total = 0;
  let entries = 0;
  async function walk(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error("Directory depth limit");
    for await (const entry of await opendir(directory)) {
      if (++entries > limits.files * 2) throw new Error("Too many package entries");
      const path = normalizePath(`${prefix}${entry.name}`);
      const absolute = join(root, path);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Package symlink forbidden");
      if (stat.isDirectory()) await walk(absolute, `${path}/`, depth + 1);
      else if (stat.isFile()) {
        if (
          files.length >= limits.files ||
          stat.size > limits.file ||
          (total += stat.size) > limits.total
        )
          throw new Error("Package exceeds limits");
        const digest = await hashFile(absolute);
        if (digest.bytes !== stat.size) throw new Error("Package changed during inspection");
        files.push({ path, ...digest, executable: (stat.mode & 0o111) !== 0 });
      } else throw new Error("Special file forbidden");
    }
  }
  await walk(root, "", 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(JSON.stringify([file.path, file.bytes, file.executable, file.hash]) + "\n");
  return { files, hash: hash.digest("hex") };
}
export async function readPackageText(
  root: string,
  files: PackageFile[],
): Promise<Record<string, string>> {
  const text: Record<string, string> = Object.create(null);
  for (const file of files)
    if (/\.(json|md|mdc|markdown|txt)$/.test(file.path)) {
      const handle = await open(
        join(root, file.path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Special file forbidden");
        if (info.size !== file.bytes) throw new Error("Integrity mismatch");
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of handle.createReadStream({
          highWaterMark: 64 * 1024,
          autoClose: false,
        })) {
          bytes += chunk.length;
          if (bytes > file.bytes || bytes > limits.file) throw new Error("Integrity mismatch");
          hash.update(chunk);
          chunks.push(chunk);
        }
        if (bytes !== file.bytes || hash.digest("hex") !== file.hash)
          throw new Error("Integrity mismatch");
        text[file.path] = Buffer.concat(chunks, bytes).toString("utf8");
      } finally {
        await handle.close();
      }
    }
  return text;
}
export async function writeContained(
  root: string,
  path: string,
  content: Uint8Array | string,
  executable = false,
): Promise<void> {
  const destination = join(root, normalizePath(path));
  await assertNoSymlinks(destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, content, { flag: "wx", mode: executable ? 0o700 : 0o600 });
}
