import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { ReleaseDirectory } from "@ace/protocol";
import { mkdir, open, lstat, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { releaseArchiveLimits } from "./artifact.ts";
export async function atomicPointer(path: string, target: string): Promise<void> {
  if (process.platform === "win32") return writePointerFile(path, target);
  const temp = path + ".next";
  await rm(temp, { force: true });
  await symlink(target, temp);
  await rename(temp, path);
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function pointer(path: string): Promise<string | undefined> {
  if (process.platform === "win32") return readPointerFile(path);
  for (let attempt = 0; ; attempt++) {
    try {
      return await readlink(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      if (error.code === "ENOENT") return undefined;
      // macOS can return EINVAL while a symlink's vnode is being replaced.
      // Retry only a confirmed link, and keep malformed pointers fatal.
      if (error.code !== "EINVAL" || attempt >= 7) throw error;
      const info = await lstat(path);
      if (!info.isSymbolicLink()) throw error;
    }
  }
}
export async function withInstallLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // SQLite's OS lock is released on process death, including crashes before initialization.
  // Use .db so migration snapshots never include the updater's live mutex connection.
  const db = new DatabaseSync(join(root, ".update-lock.db"));
  let locked = false;
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    locked = true;
    return await work();
  } finally {
    if (locked) db.exec("ROLLBACK");
    db.close();
  }
}
export async function durableJson(path: string, value: unknown): Promise<void> {
  const file = await open(path + ".next", "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(path + ".next", path);
  // Windows cannot open a directory to flush it; NTFS journals the rename itself.
  if (process.platform === "win32") return;
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const dir = await open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function durableRemove(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}
export async function syncTree(root: string): Promise<void> {
  if (process.platform === "win32") return syncWindowsTree(root);
  const { readdir } = await import("node:fs/promises");
  // The same budget the archive enforces (releaseArchiveLimits): regular files, not the
  // directories that hold them, which are bounded separately.
  let files = 0,
    directories = 0;
  async function visit(path: string) {
    for (const name of await readdir(path)) {
      const file = join(path, name),
        info = await lstat(file);
      if (info.isDirectory()) {
        if (++directories > releaseArchiveLimits.entries)
          throw new Error("Release directory limit exceeded");
        await visit(file);
      } else if (info.isFile()) {
        if (++files > releaseArchiveLimits.entries) throw new Error("Release file limit exceeded");
        const handle = await open(file, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else throw new Error("Release contains a link or special file");
    }
    await syncDirectory(path);
  }
  await visit(root);
}

export async function releasePointer(root: string): Promise<ReleaseDirectory> {
  return ReleaseDirectory.parse(await pointer(join(root, "current")));
}

const sharingViolations = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * Runs `work`, retrying for about five seconds while Windows reports a sharing violation: an
 * antivirus scan, the indexer or a just-exited process can hold a file a moment longer.
 */
export async function retrySharing<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (typeof code !== "string" || !sharingViolations.has(code) || attempt >= 12) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 25 * 2 ** attempt)));
    }
  }
}

/**
 * Windows keeps `current` and `previous` as small files naming the release directory (ADR 0095):
 * directory symlinks need Developer Mode and cannot be replaced by a rename.
 */
async function writePointerFile(path: string, target: string): Promise<void> {
  const temp = path + ".next";
  await rm(temp, { force: true });
  const file = await open(temp, "w", 0o600);
  try {
    await file.writeFile(target);
    await file.sync();
  } finally {
    await file.close();
  }
  await retrySharing(() => rename(temp, path));
}

async function readPointerFile(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 256) throw new Error(`Invalid release pointer ${path}`);
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/** Flushes every release file on Windows, where only a writable handle can be flushed. */
async function syncWindowsTree(root: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  let files = 0,
    directories = 0;
  async function visit(path: string) {
    for (const name of await readdir(path)) {
      const file = join(path, name),
        info = await lstat(file);
      if (info.isDirectory()) {
        if (++directories > releaseArchiveLimits.entries)
          throw new Error("Release directory limit exceeded");
        await visit(file);
      } else if (info.isFile()) {
        if (++files > releaseArchiveLimits.entries) throw new Error("Release file limit exceeded");
        const handle = await open(file, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else throw new Error("Release contains a link or special file");
    }
  }
  await visit(root);
}
