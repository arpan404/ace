import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { keyPair } from "./crypto.ts";
import type { KeyPair } from "./crypto.ts";
export type HostIdentityFile = {
  stat(): Promise<Pick<Stats, "isFile" | "mode" | "size">>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};
/** Trusted descriptor I/O; the loader supplies no-follow/nonblocking flags and owns closure. */
export type OpenHostIdentity = (path: string, flags: number) => Promise<HostIdentityFile>;
/** Atomic publication avoids exposing partially written keys to concurrent starts. */
export async function loadOrCreateHostKeys(
  dataDir: string,
  openIdentity: OpenHostIdentity = open,
): Promise<KeyPair> {
  const path = join(dataDir, "noise-static.key");
  try {
    return await loadHostKeys(path, openIdentity);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = join(dataDir, `.noise-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(keyPair().privateKey);
    await file.sync();
    await file.close();
    try {
      await link(temporary, path);
      const directory = await open(dataDir, constants.O_RDONLY);
      // Windows can't flush a directory handle (EPERM); NTFS journals the new link itself.
      if (process.platform === "win32") Object.assign(directory, { sync: async () => {} });
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  } finally {
    await file.close();
    await unlink(temporary);
  }
  return loadHostKeys(path, openIdentity);
}

async function loadHostKeys(path: string, openIdentity: OpenHostIdentity): Promise<KeyPair> {
  if (process.platform === "win32") return loadWindowsHostKeys(path);
  const stored = await openIdentity(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await stored.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
      throw new Error("Static key must be a regular file with mode 0600");
    if (stat.size !== 32) throw new Error("Invalid stored static key");
    // One sentinel byte detects growth after stat without an unbounded readFile allocation.
    const bytes = new Uint8Array(33);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await stored.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size !== 32 || (await stored.stat()).size !== 32)
      throw new Error("Invalid stored static key");
    return keyPair(bytes.subarray(0, 32));
  } finally {
    await stored.close();
  }
}

/**
 * Windows has no mode bits to check: ace's data-home ACL keeps the key private there. A link or
 * a key of the wrong size is still refused rather than replaced.
 */
async function loadWindowsHostKeys(path: string): Promise<KeyPair> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error("Static key must be a regular file");
  const stored = await open(path, "r");
  try {
    if ((await stored.stat()).size !== 32) throw new Error("Invalid stored static key");
    // One sentinel byte detects growth after stat without an unbounded read.
    const bytes = new Uint8Array(33);
    const { bytesRead } = await stored.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== 32) throw new Error("Invalid stored static key");
    return keyPair(bytes.subarray(0, 32));
  } finally {
    await stored.close();
  }
}
