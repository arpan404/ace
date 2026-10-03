import { DatabaseSync, backup } from "node:sqlite";
import { opendir, mkdir, copyFile, rm, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "./files.ts";
import { z } from "zod";
export const DatabaseInventory = z
  .array(
    z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.sqlite$/)
      .max(160),
  )
  .max(32)
  .refine((names) => new Set(names).size === names.length, "Duplicate database inventory");
export async function snapshotDatabases(dataDir: string, destination: string): Promise<string[]> {
  await mkdir(destination, { mode: 0o700 });
  const names: string[] = [];
  for await (const entry of await opendir(dataDir)) {
    if (!entry.name.endsWith(".sqlite")) continue;
    if (names.length >= 32) throw new Error("Too many databases");
    names.push(entry.name);
  }
  DatabaseInventory.parse(names);
  for (const name of names) {
    const db = new DatabaseSync(join(dataDir, name), { readOnly: true });
    try {
      await backup(db, join(destination, name));
    } finally {
      db.close();
    }
  }
  return names;
}
/** Caller has stopped the daemon. Originals include the old schema and WAL contents. */
export async function restoreDatabases(
  dataDir: string,
  snapshot: string,
  inventory: unknown,
): Promise<void> {
  // Validate the entire snapshot before deleting anything. Recovery keeps this copy
  // until the restored files are durable, so another crash can repeat the operation.
  const expected = DatabaseInventory.parse(inventory);
  const actual = new Set<string>();
  const names: string[] = [];
  for await (const entry of await opendir(snapshot)) {
    if (names.length >= expected.length || !expected.includes(entry.name))
      throw new Error("Rollback snapshot inventory mismatch");
    names.push(entry.name);
    actual.add(entry.name);
  }
  if (names.length !== expected.length || expected.some((name) => !actual.has(name)))
    throw new Error("Rollback snapshot inventory mismatch");
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
  for await (const entry of await opendir(dataDir)) {
    if (/\.sqlite(?:-wal|-shm)?$/.test(entry.name))
      await rm(join(dataDir, entry.name), { force: true });
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
