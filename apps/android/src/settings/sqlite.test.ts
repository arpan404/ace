import type { SQLiteDatabase } from "expo-sqlite";
import { describe, expect, it } from "vitest";
import { APP_LOCK_ENABLED_KEY, APP_LOCK_TIMEOUT_KEY } from "./appLock.ts";
import { APPEARANCE_STORAGE_KEY } from "./appearance.ts";
import {
  SETTINGS_NAMESPACE,
  ensureSettingsTables,
  saveSettingsTransaction,
  sqliteSettingsKeyValue,
} from "./sqlite.ts";
import { DEFAULT_SETTINGS, loadSettings } from "./store.ts";

/**
 * In-memory stand-in for `expo-sqlite` that honors exclusive-transaction
 * semantics: writes inside `withExclusiveTransactionAsync` land on a scratch
 * copy committed only when the task resolves, so a mid-task failure leaves
 * the committed state untouched — exactly what the real transaction
 * guarantees on device.
 */
function createFakeDb(seed: Record<string, string> = {}) {
  const committed = new Map<string, string>(Object.entries(seed));
  const events: Array<string> = [];
  let writes = 0;
  let failOnWrite = -1;
  const db = {
    async execAsync(_source: string): Promise<void> {
      events.push("exec");
    },
    async getFirstAsync(
      _source: string,
      _namespace: string,
      key: string,
    ): Promise<{ value: string } | null> {
      const value = committed.get(key);
      return value === undefined ? null : { value };
    },
    runAsync: (_source: string, _namespace: string, _key: string, _value?: string) =>
      Promise.reject(new Error("runAsync outside a transaction is unsupported in fake")),
    async withExclusiveTransactionAsync(
      task: (txn: {
        runAsync(source: string, namespace: string, key: string, value?: string): Promise<unknown>;
      }) => Promise<void>,
    ): Promise<void> {
      events.push("begin");
      const scratch = new Map(committed);
      const txn = {
        runAsync: (source: string, _namespace: string, key: string, value?: string) => {
          writes += 1;
          events.push(`write:${key}`);
          if (writes === failOnWrite) return Promise.reject(new Error("unavailable"));
          if (source.startsWith("DELETE")) scratch.delete(key);
          else if (value !== undefined) scratch.set(key, value);
          return Promise.resolve({ lastInsertRowId: 0, changes: 1 });
        },
      };
      try {
        await task(txn);
      } catch (error) {
        events.push("rollback");
        throw error;
      }
      committed.clear();
      for (const [key, value] of scratch) committed.set(key, value);
      events.push("commit");
    },
  };
  return {
    db: db as unknown as SQLiteDatabase,
    events,
    snapshot: () => Object.fromEntries(committed),
    failOnWrite: (n: number) => {
      failOnWrite = n;
      writes = 0;
    },
  };
}

describe("settings SQLite transaction", () => {
  it("writes every key inside a single exclusive transaction", async () => {
    const fake = createFakeDb();
    await saveSettingsTransaction(fake.db, SETTINGS_NAMESPACE, {
      appearance: "dark",
      lockEnabled: true,
      lockTimeoutSeconds: 300,
    });
    expect(fake.snapshot()).toEqual({
      [APPEARANCE_STORAGE_KEY]: "dark",
      [APP_LOCK_ENABLED_KEY]: "true",
      [APP_LOCK_TIMEOUT_KEY]: "300",
    });
    expect(fake.events).toEqual([
      "begin",
      `write:${APPEARANCE_STORAGE_KEY}`,
      `write:${APP_LOCK_ENABLED_KEY}`,
      `write:${APP_LOCK_TIMEOUT_KEY}`,
      "commit",
    ]);
  });

  it("commits nothing when a mid-write failure aborts the transaction", async () => {
    const fake = createFakeDb({
      [APP_LOCK_ENABLED_KEY]: "false",
      [APP_LOCK_TIMEOUT_KEY]: "60",
    });
    fake.failOnWrite(2);
    await expect(
      saveSettingsTransaction(fake.db, SETTINGS_NAMESPACE, {
        lockEnabled: true,
        lockTimeoutSeconds: 300,
      }),
    ).rejects.toThrow("unavailable");
    expect(fake.snapshot()).toEqual({
      [APP_LOCK_ENABLED_KEY]: "false",
      [APP_LOCK_TIMEOUT_KEY]: "60",
    });
    expect(fake.events).toEqual([
      "begin",
      `write:${APP_LOCK_ENABLED_KEY}`,
      `write:${APP_LOCK_TIMEOUT_KEY}`,
      "rollback",
    ]);
  });

  it("opens no transaction for empty patches", async () => {
    const fake = createFakeDb();
    await saveSettingsTransaction(fake.db, SETTINGS_NAMESPACE, {});
    expect(fake.events).toEqual([]);
  });

  it("exposes the transaction as the key/value store's atomic commit", async () => {
    const fake = createFakeDb({
      [APP_LOCK_ENABLED_KEY]: "false",
      [APP_LOCK_TIMEOUT_KEY]: "60",
    });
    const storage = sqliteSettingsKeyValue(fake.db);
    expect(storage.saveAtomic).toBeDefined();
    fake.failOnWrite(2);
    await expect(
      storage.saveAtomic?.({ lockEnabled: true, lockTimeoutSeconds: 300 }),
    ).rejects.toThrow("unavailable");
    // The aborted transaction left the committed reads intact.
    expect(await loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("creates the metadata table before first use", async () => {
    const fake = createFakeDb();
    await ensureSettingsTables(fake.db);
    expect(fake.events).toEqual(["exec"]);
  });
});
