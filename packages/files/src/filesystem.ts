import { constants } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { SafeRoot, GitIgnore, walkWorkspace } from "@ace/workspace";
import { z } from "zod";
import { CHUNK_SIZE, codeOf, FileError, version, checkVersion } from "./types.ts";
import type { UploadRecord } from "./catalog.ts";

export async function observed(safe: SafeRoot, path: string): Promise<string | null> {
  const target = await safe.target(path);
  try {
    const info = await lstat(target.path);
    const current = version(info);
    if (!info.isDirectory()) return current;
    const digest = createHash("sha256").update(current);
    const ignore = await GitIgnore.create(safe);
    for await (const entry of walkWorkspace(safe, ignore, {
      dir: safe.path(path),
      depth: Number.MAX_SAFE_INTEGER,
      includeIgnored: true,
      exclude: () => false,
    })) {
      if (entry.path.split("/").some((part) => part.startsWith(".ace-upload-"))) continue;
      const metadata = await safe.metadata(entry.path);
      digest.update(entry.path);
      digest.update("\0");
      digest.update(version(metadata.info));
      digest.update("\0");
    }
    return `tree:${digest.digest("hex")}`;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}
export async function checkedTarget(safe: SafeRoot, path: string, expected: string | null) {
  const target = await safe.target(path);
  checkVersion(await observed(safe, path), expected);
  await target.verify();
  return target;
}
export async function writeAll(handle: FileHandle, bytes: Buffer, offset: number): Promise<void> {
  let done = 0;
  while (done < bytes.length) {
    const result = await handle.write(bytes, done, bytes.length - done, offset + done);
    if (!result.bytesWritten) throw new FileError("IO_ERROR", "Short write");
    done += result.bytesWritten;
  }
}
export async function hashFile(handle: FileHandle): Promise<string> {
  const digest = createHash("sha256");
  const bytes = Buffer.allocUnsafe(CHUNK_SIZE);
  let position = 0;
  for (;;) {
    const result = await handle.read(bytes, 0, bytes.length, position);
    if (!result.bytesRead) break;
    digest.update(bytes.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  return digest.digest("hex");
}
export async function openUpload(
  safe: SafeRoot,
  record: UploadRecord,
): Promise<{ handle: FileHandle; verify(): Promise<void> }> {
  const target = await safe.target(record.path);
  const handle = await open(
    join(dirname(target.path), record.temp),
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || `${info.dev}:${info.ino}` !== record.identity || info.size > record.bytes)
      throw new FileError("CONFLICT", "Upload temp file changed");
    const temp = join(dirname(target.path), record.temp);
    const verify = async () => {
      await target.verify();
      const current = await lstat(temp);
      if (!current.isFile() || `${current.dev}:${current.ino}` !== record.identity)
        throw new FileError("CONFLICT", "Upload path changed");
    };
    await verify();
    return { handle, verify };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export function newId(id: () => string): string {
  return z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .parse(id());
}
export async function replacementMode(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isFile()) throw new FileError("NOT_FILE", "Replacement target must be a regular file");
  return info.mode & 0o777;
}
export async function atomicWrite(
  safe: SafeRoot,
  path: string,
  expected: string | null,
  bytes: Buffer,
  id: string,
): Promise<void> {
  const target = await checkedTarget(safe, path, expected);
  const temp = join(dirname(target.path), `.ace-upload-${id}`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await writeAll(handle, bytes, 0);
    await handle.sync();
    await checkedTarget(safe, path, expected);
    await target.verify();
    if (expected !== null) await handle.chmod(await replacementMode(target.path));
    await rename(temp, target.path);
    await target.verify();
  } finally {
    await handle.close();
    await rm(temp, { force: true });
  }
}
