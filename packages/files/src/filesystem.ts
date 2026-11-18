import type { Stats } from "node:fs";
import type { ExclusiveRename } from "./exclusive-rename.ts";
import { constants } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { publishReplacement } from "./replacement.ts";
import { SafeRoot, GitIgnore, walkWorkspace, isWorkspaceTransferTemporary } from "@ace/workspace";
import { z } from "zod";
import { CHUNK_SIZE, codeOf, FileError, version, checkVersion } from "./types.ts";
import type { UploadRecord } from "./catalog.ts";
import { chmod } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function observed(
  safe: SafeRoot,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const target = await safe.target(path);
  try {
    const info = await lstat(target.path);
    const current = version(info);
    if (!info.isDirectory()) return current;
    return await treeVersion(safe, path, info, signal);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * The `tree:` digest of a folder: its own version, then every entry below it as `path`, NUL,
 * version, NUL. `files-io`'s folder versions are computed the same way, so a version from either
 * side is accepted by the other.
 */
export async function treeVersion(
  safe: SafeRoot,
  path: string,
  info: Stats,
  signal?: AbortSignal,
): Promise<string> {
  const digest = createHash("sha256").update(version(info));
  const ignore = await GitIgnore.create(safe);
  for await (const entry of walkWorkspace(safe, ignore, {
    dir: safe.path(path),
    depth: Number.MAX_SAFE_INTEGER,
    includeIgnored: true,
    exclude: isWorkspaceTransferTemporary,
    entryLimit: 1_000_000,
    ...(signal ? { signal } : {}),
  })) {
    if (isWorkspaceTransferTemporary(entry.path)) continue;
    const metadata = await safe.metadata(entry.path);
    digest.update(entry.path);
    digest.update("\0");
    digest.update(version(metadata.info));
    digest.update("\0");
  }
  return `tree:${digest.digest("hex")}`;
}
export async function checkedTarget(
  safe: SafeRoot,
  path: string,
  expected: string | null,
  signal?: AbortSignal,
) {
  const target = await safe.target(path);
  checkVersion(await observed(safe, path, signal), expected);
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
export async function hashFile(handle: {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}): Promise<string> {
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
  exclusive: ExclusiveRename,
): Promise<void> {
  const target = await checkedTarget(safe, path, expected);
  const temp = join(dirname(target.path), `.ace-upload-${id}`);
  const handle = await open(temp, "wx", 0o600);
  const own = await handle.stat();
  try {
    await writeAll(handle, bytes, 0);
    await handle.sync();
    await checkedTarget(safe, path, expected);
    await target.verify();
    if (expected !== null) await handle.chmod(await replacementMode(target.path));
    if (process.platform === "win32" && expected !== null) {
      await windowsReplace(temp, target.path);
      await target.verify();
      return;
    }
    if (expected === null) await exclusive.move(temp, target.path);
    else
      await publishReplacement({
        exclusive,
        temp,
        identity: `${own.dev}:${own.ino}`,
        destination: target.path,
        expected,
        id,
      });
    await target.verify();
  } finally {
    await handle.close();
    // Only this write's own file: a refused exchange may have left another program's save here.
    const left = await lstat(temp).catch(() => undefined);
    if (left && left.dev === own.dev && left.ino === own.ino) await rm(temp, { force: true });
  }
}

/**
 * Windows: rename `temp` over an existing file. Windows refuses that while the file is
 * read-only, or while another program holds it open without delete sharing. The read-only
 * attribute is lifted just before the rename and put back if the rename fails; the incoming
 * file already carries the same mode, so a read-only file stays read-only. Sharing violations
 * are retried for under a second, then reported.
 */
export async function windowsReplace(temp: string, destination: string): Promise<void> {
  const before = await lstat(destination);
  const readOnly = before.isFile() && (before.mode & 0o200) === 0;
  if (readOnly) await chmod(destination, 0o666);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, destination);
        return;
      } catch (error) {
        if (attempt >= 5 || !["EBUSY", "EPERM", "EACCES"].includes(codeOf(error))) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  } catch (error) {
    if (readOnly) await chmod(destination, before.mode & 0o777).catch(() => {});
    throw error;
  }
}
