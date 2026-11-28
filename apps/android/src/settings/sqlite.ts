import type { SQLiteDatabase } from "expo-sqlite";
import { encodeSettings, type SettingsKeyValue, type SettingsState } from "./store.ts";

/** Phone-local namespace inside the settings database's metadata table. */
export const SETTINGS_NAMESPACE = "android-settings";

export async function ensureSettingsTables(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(
    "CREATE TABLE IF NOT EXISTS metadata (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key));",
  );
}

interface MetadataRow {
  value: string;
}

/**
 * Crash-atomic multi-key commit: every key in the patch is written inside one
 * exclusive SQLite transaction, so a failure or a process kill mid-write
 * commits nothing — a restart can never read a torn mix of old and new
 * values. This is the backend the serialized writer prefers (via
 * `SettingsKeyValue.saveAtomic`); generic key/value stores without
 * transactions can only offer best-effort rollback.
 */
export async function saveSettingsTransaction(
  db: Pick<SQLiteDatabase, "withExclusiveTransactionAsync">,
  namespace: string,
  patch: Partial<SettingsState>,
): Promise<void> {
  const entries = encodeSettings(patch);
  if (entries.length === 0) return;
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const [key, value] of entries) {
      await txn.runAsync(
        "INSERT OR REPLACE INTO metadata (namespace, key, value) VALUES (?,?,?)",
        namespace,
        key,
        value,
      );
    }
  });
}

/** String key/value pairs scoped to `namespace`, mirroring iOS UserDefaults keys. */
export function sqliteSettingsKeyValue(
  db: SQLiteDatabase,
  namespace: string = SETTINGS_NAMESPACE,
): SettingsKeyValue {
  return {
    async getItem(key: string): Promise<string | null> {
      const row = (await db.getFirstAsync(
        "SELECT value FROM metadata WHERE namespace=? AND key=?",
        namespace,
        key,
      )) as MetadataRow | null;
      return row === null ? null : row.value;
    },
    async setItem(key: string, value: string): Promise<void> {
      await db.runAsync(
        "INSERT OR REPLACE INTO metadata (namespace, key, value) VALUES (?,?,?)",
        namespace,
        key,
        value,
      );
    },
    async removeItem(key: string): Promise<void> {
      await db.runAsync("DELETE FROM metadata WHERE namespace=? AND key=?", namespace, key);
    },
    async saveAtomic(patch: Partial<SettingsState>): Promise<void> {
      await saveSettingsTransaction(db, namespace, patch);
    },
  };
}
