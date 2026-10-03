import { DatabaseSync } from "node:sqlite";
import { ReleaseDirectory } from "@ace/protocol";
import { mkdir, open, lstat, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
export async function atomicPointer(path: string, target: string): Promise<void> {
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
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function syncDirectory(path: string): Promise<void> {
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
  const { readdir } = await import("node:fs/promises");
  let entries = 0;
  async function visit(path: string) {
    for (const name of await readdir(path)) {
      if (++entries > 2048) throw new Error("Release file limit exceeded");
      const file = join(path, name),
        info = await lstat(file);
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
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
