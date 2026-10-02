import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { assertNoSymlinks } from "./files.ts";

/** A separate SQLite transaction serializes filesystem mutations and releases on process death. */
export async function withDirectoryLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const path = join(root, "operation.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) await assertNoSymlinks(path + suffix);
  const db = new DatabaseSync(path);
  try {
    try {
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    } catch (error) {
      throw new Error("Plugin manager busy", { cause: error });
    }
    try {
      const value = await run();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
