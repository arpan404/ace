import type { Storage } from "@ace/client";
import type { SQLiteDatabase } from "expo-sqlite";
import { z } from "zod";
const Row = z.object({ value: z.string() });
/** One owner per daemon/device namespace. Every resolved write is committed to disk. */
export async function sqliteOutbox(db: SQLiteDatabase, namespace: string): Promise<Storage> {
  await db.execAsync(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS outbox (namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,id));
    CREATE TABLE IF NOT EXISTS metadata (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key));`);
  async function read(key: string) {
    const row: unknown = await db.getFirstAsync(
      "SELECT value FROM metadata WHERE namespace=? AND key=?",
      namespace,
      key,
    );
    return row === null ? null : Row.parse(row).value;
  }
  async function write(key: string, value: string) {
    await db.withExclusiveTransactionAsync(async (tx) => {
      await tx.runAsync("INSERT OR REPLACE INTO metadata VALUES (?,?,?)", namespace, key, value);
    });
  }
  return {
    load: () => read("legacy"),
    save: (value) => write("legacy", value),
    hostBinding: { load: () => read("host"), save: (value) => write("host", value) },
    records: {
      async load() {
        const rows: unknown = await db.getAllAsync(
          "SELECT value FROM outbox WHERE namespace=? ORDER BY id",
          namespace,
        );
        return z
          .array(Row)
          .parse(rows)
          .map((row) => row.value);
      },
      async write(id, value) {
        await db.withExclusiveTransactionAsync(async (tx) => {
          if (value === null)
            await tx.runAsync("DELETE FROM outbox WHERE namespace=? AND id=?", namespace, id);
          else
            await tx.runAsync("INSERT OR REPLACE INTO outbox VALUES (?,?,?)", namespace, id, value);
        });
      },
    },
  };
}
