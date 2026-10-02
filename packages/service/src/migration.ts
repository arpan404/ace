import { DatabaseSync, backup } from "node:sqlite";
import { readdir, mkdir, copyFile, rm, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "./files.ts";
export async function snapshotDatabases(dataDir: string, destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  const names = (await readdir(dataDir)).filter((name) => name.endsWith(".sqlite"));
  if (names.length > 32) throw new Error("Too many databases");
  for (const name of names) {
    const db = new DatabaseSync(join(dataDir, name), { readOnly: true });
    try {
      await backup(db, join(destination, name));
    } finally {
      db.close();
    }
  }
}
/** Caller has stopped the daemon. Originals include the old schema and WAL contents. */
export async function restoreDatabases(dataDir: string, snapshot: string): Promise<void> {
  // Validate the entire snapshot before deleting anything. Recovery keeps this copy
  // until the restored files are durable, so another crash can repeat the operation.
  const names = await readdir(snapshot);
  if (names.length > 32) throw new Error("Too many snapshot databases");
  for (const name of names) {
    if (!name.endsWith(".sqlite") || !(await lstat(join(snapshot, name))).isFile())
      throw new Error("Invalid migration snapshot");
    const db = new DatabaseSync(join(snapshot, name), { readOnly: true });
    try {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw new Error("Invalid migration snapshot");
    } finally {
      db.close();
    }
  }
  // Remove newly introduced candidate databases as well as old sidecars.
  for (const name of await readdir(dataDir)) {
    if (/\.sqlite(?:-wal|-shm)?$/.test(name)) await rm(join(dataDir, name), { force: true });
  }
  for (const name of names) {
    await copyFile(join(snapshot, name), join(dataDir, name));
    const file = await open(join(dataDir, name), "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  await syncDirectory(dataDir);
}
