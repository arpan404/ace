import type { SQLiteDatabase } from "expo-sqlite";
import type { AppLockStorage } from "./app-lock.ts";

/**
 * SQLite-backed persistence for the production app-lock choice.
 *
 * Mirrors the iOS `AppLock` `defaults` (`ace.lock.enabled`/`ace.lock.timeout`
 * in `UserDefaults.standard`): the person's explicit on/off choice and
 * timeout survive restarts in the shared `ace-production.db` under the
 * `ace-lock` metadata namespace, beside the directory and grant namespaces
 * but never beside credentials. A stored choice always wins over the
 * paired-or-not default, so turning the lock off stays off across launches
 * and the first pairing only enables the lock when no choice was recorded.
 *
 * Reads are synchronous from an in-memory mirror seeded by
 * `readStoredLockPrefs` before `createAppLock` runs; writes update the
 * mirror at once and flush to disk through a serialized tail so rapid
 * toggles cannot reorder. `flush()` lets shutdown await the tail before the
 * database closes. Everything unknown or malformed reads as `undefined`
 * (fail over to the caller default, which is locked), never as a choice the
 * person did not make.
 */

const NAMESPACE = "ace-lock";
const ENABLED_KEY = "enabled";
const TIMEOUT_KEY = "timeout";

export interface StoredLockPrefs {
  enabled?: boolean | undefined;
  timeout?: number | undefined;
}

/** The rows the app-lock choice persists as. Exported for tests. */
export function parseLockRow(
  key: string,
  value: unknown,
): { enabled: boolean } | { timeout: number } | undefined {
  if (typeof value !== "string") return undefined;
  if (key === ENABLED_KEY) {
    if (value === "1") return { enabled: true };
    if (value === "0") return { enabled: false };
    return undefined;
  }
  if (key === TIMEOUT_KEY) {
    if (!/^[0-9]+$/.test(value)) return undefined;
    return { timeout: Number(value) };
  }
  return undefined;
}

/** Read the persisted choice without creating it. Never throws. */
export async function readStoredLockPrefs(db: SQLiteDatabase): Promise<StoredLockPrefs> {
  return (await readStoredLockPrefsWithStatus(db)).prefs;
}

/**
 * Read the persisted choice and report whether the read itself failed.
 * A failed read is fail-closed downstream: the secure-screen toggle keeps
 * the window guarded until a durable choice is actually known, instead of
 * treating "no rows" (unreadable table) as "the person turned the lock off".
 * Never throws.
 */
export async function readStoredLockPrefsWithStatus(db: SQLiteDatabase): Promise<{
  prefs: StoredLockPrefs;
  storageFailed: boolean;
}> {
  const prefs: StoredLockPrefs = {};
  try {
    const rows = (await db.getAllAsync(
      "SELECT key, value FROM metadata WHERE namespace=?",
      NAMESPACE,
    )) as readonly unknown[];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const { key, value } = row as { key?: unknown; value?: unknown };
      if (typeof key !== "string") continue;
      const parsed = parseLockRow(key, value);
      if (parsed !== undefined && "enabled" in parsed) prefs.enabled = parsed.enabled;
      else if (parsed !== undefined && "timeout" in parsed) prefs.timeout = parsed.timeout;
    }
  } catch {
    // A missing or unreadable table reads as no choice; the caller default
    // (locked) applies and nothing is created before unlock.
    return { prefs: {}, storageFailed: true };
  }
  return { prefs, storageFailed: false };
}

export function sqliteAppLockStorage(
  db: SQLiteDatabase,
  initial?: StoredLockPrefs | undefined,
): AppLockStorage & { flush(): Promise<void> } {
  let enabled = initial?.enabled;
  let timeout = initial?.timeout;
  let tail: Promise<void> = Promise.resolve();
  // The last serialized write wins: success clears the flag, failure sets it.
  // `flush()` reports the flag so a failed save cannot silently claim
  // success — the mirror already updated for responsiveness, but the durable
  // row is stale until a later write succeeds.
  let lastWriteFailed = false;
  const WRITE_FAILED_MESSAGE =
    "The app-lock choice could not be saved. It applies until restart, then reverts.";

  function persist(key: string, value: string): void {
    tail = tail
      .then(() =>
        db.withExclusiveTransactionAsync(async (tx) => {
          await tx.runAsync(
            "INSERT OR REPLACE INTO metadata VALUES (?,?,?)",
            NAMESPACE,
            key,
            value,
          );
        }),
      )
      .then(() => {
        lastWriteFailed = false;
      })
      .catch(() => {
        lastWriteFailed = true;
      });
  }

  return {
    readEnabled: () => enabled,
    readTimeout: () => timeout,
    writeEnabled(next) {
      enabled = next;
      persist(ENABLED_KEY, next ? "1" : "0");
    },
    writeTimeout(next) {
      timeout = next;
      persist(TIMEOUT_KEY, String(next));
    },
    flush: async () => {
      await tail;
      if (lastWriteFailed) throw new Error(WRITE_FAILED_MESSAGE);
    },
  };
}
