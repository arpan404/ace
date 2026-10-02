import { DatabaseSync, backup } from "node:sqlite";
import { readdir, mkdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
  // Remove newly introduced candidate databases as well as old sidecars.
  for (const name of await readdir(dataDir)) {
    if (/\.sqlite(?:-wal|-shm)?$/.test(name)) await rm(join(dataDir, name), { force: true });
  }
  for (const name of await readdir(snapshot)) {
    if (!name.endsWith(".sqlite")) throw new Error("Invalid migration snapshot");
    await copyFile(join(snapshot, name), join(dataDir, name));
  }
}
