import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { join } from "node:path";
import { secureDataDir } from "../local-files.ts";
/** Indexed record writes commit before SDK dispatch; concurrent observers share receipts. */
export function cliStorage(home: string) {
  secureDataDir(home);
  const db = new DatabaseSync(join(home, "cli-outbox.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY,value TEXT NOT NULL)",
  );
  const storage = {
    async load() {
      return null;
    },
    async save(_value: string) {},
    records: {
      async load() {
        return db
          .prepare("SELECT value FROM intents")
          .all()
          .map((row) => String(row.value));
      },
      async write(id: string, value: string | null) {
        if (value === null) db.prepare("DELETE FROM intents WHERE id=?").run(id);
        else
          db.prepare(
            "INSERT INTO intents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
          ).run(id, value);
      },
    },
    hostBinding: {
      async load() {
        const row = db.prepare("SELECT value FROM binding WHERE id=1").get();
        return row ? String(row.value) : null;
      },
      async save(host: string) {
        db.prepare(
          "INSERT INTO binding VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        ).run(host);
      },
    },
  };
  return {
    storage,
    close() {
      db.close();
    },
  };
}
