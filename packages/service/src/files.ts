import { mkdir, open, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
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
  try {
    return await readlink(path);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  }
}
export async function withInstallLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, ".update-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    const recovery = join(root, ".lock-recovery");
    await mkdir(recovery, { mode: 0o700 });
    try {
      const pid = Number(await readFile(join(lock, "pid"), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Invalid update lock owner", { cause: e });
      try {
        process.kill(pid, 0);
        throw new Error("Another updater owns the installation", { cause: e });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
      await rm(lock, { recursive: true });
      await mkdir(lock, { mode: 0o700 });
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
  }
  await writeFile(join(lock, "pid"), String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
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
  const { readdir, lstat } = await import("node:fs/promises");
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
