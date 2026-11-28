import { expect, it } from "vitest";
import type { SQLiteDatabase } from "expo-sqlite";
import {
  parseLockRow,
  readStoredLockPrefs,
  readStoredLockPrefsWithStatus,
  sqliteAppLockStorage,
} from "./lock-storage.ts";

/** Minimal in-memory stand-in for the metadata table the storage uses. */
function fakeDb(initial: Record<string, Record<string, string>> = {}): {
  db: SQLiteDatabase;
  tables: Record<string, Record<string, string>>;
} {
  const tables: Record<string, Record<string, string>> = Object.fromEntries(
    Object.entries(initial).map(([namespace, rows]) => [namespace, { ...rows }]),
  );
  const db = {
    async getAllAsync(sql: string, ...args: unknown[]) {
      if (!sql.includes("FROM metadata")) throw new Error(`unexpected query: ${sql}`);
      const namespace = args[0] as string;
      return Object.entries(tables[namespace] ?? {}).map(([key, value]) => ({ key, value }));
    },
    async getFirstAsync() {
      throw new Error("unused");
    },
    async runAsync() {
      throw new Error("unused");
    },
    async withExclusiveTransactionAsync<T>(
      work: (tx: { runAsync(sql: string, ...args: unknown[]): Promise<unknown> }) => Promise<T>,
    ): Promise<T> {
      return work({
        async runAsync(sql: string, ...args: unknown[]) {
          if (!sql.includes("INSERT OR REPLACE INTO metadata"))
            throw new Error(`unexpected: ${sql}`);
          const [namespace, key, value] = args as [string, string, string];
          tables[namespace] ??= {};
          tables[namespace][key] = value;
          return { lastInsertRowId: 0, changes: 1 };
        },
      });
    },
  } as unknown as SQLiteDatabase;
  return { db, tables };
}

it("rejects malformed lock rows instead of inventing a choice", () => {
  expect(parseLockRow("enabled", "1")).toEqual({ enabled: true });
  expect(parseLockRow("enabled", "0")).toEqual({ enabled: false });
  expect(parseLockRow("enabled", "yes")).toBeUndefined();
  expect(parseLockRow("enabled", 1)).toBeUndefined();
  expect(parseLockRow("timeout", "300")).toEqual({ timeout: 300 });
  expect(parseLockRow("timeout", "abc")).toBeUndefined();
  expect(parseLockRow("timeout", "-5")).toBeUndefined();
  expect(parseLockRow("other", "1")).toBeUndefined();
});

it("reads the stored choice and ignores unknown rows", async () => {
  const { db } = fakeDb({ "ace-lock": { enabled: "0", timeout: "300", other: "x" } });
  expect(await readStoredLockPrefs(db)).toEqual({ enabled: false, timeout: 300 });
});

it("an unreadable table reads as no choice, never throws", async () => {
  const broken = {
    getAllAsync: async () => {
      throw new Error("no such table");
    },
  } as unknown as SQLiteDatabase;
  expect(await readStoredLockPrefs(broken)).toEqual({});
});

it("an unreadable table reports storage failure so the screen stays guarded", async () => {
  const broken = {
    getAllAsync: async () => {
      throw new Error("no such table");
    },
  } as unknown as SQLiteDatabase;
  expect(await readStoredLockPrefsWithStatus(broken)).toEqual({
    prefs: {},
    storageFailed: true,
  });
});

it("a readable table reports no storage failure", async () => {
  const { db } = fakeDb({ "ace-lock": { enabled: "0", timeout: "300", other: "x" } });
  expect(await readStoredLockPrefsWithStatus(db)).toEqual({
    prefs: { enabled: false, timeout: 300 },
    storageFailed: false,
  });
});

it("a stored choice round-trips and wins over the constructor default", async () => {
  const { db, tables } = fakeDb();
  const storage = sqliteAppLockStorage(db, await readStoredLockPrefs(db));
  expect(storage.readEnabled()).toBeUndefined();
  storage.writeEnabled(false);
  storage.writeTimeout(900);
  await storage.flush();
  expect(tables["ace-lock"]).toEqual({ enabled: "0", timeout: "900" });
  expect(await readStoredLockPrefs(db)).toEqual({ enabled: false, timeout: 900 });
});

it("rapid toggles persist in order", async () => {
  const { db, tables } = fakeDb({ "ace-lock": { enabled: "1" } });
  const storage = sqliteAppLockStorage(db, await readStoredLockPrefs(db));
  storage.writeEnabled(false);
  storage.writeEnabled(true);
  storage.writeEnabled(false);
  expect(storage.readEnabled()).toBe(false);
  await storage.flush();
  expect(tables["ace-lock"]?.["enabled"]).toBe("0");
});

it("a failed write rejects flush instead of silently claiming success", async () => {
  const { db } = fakeDb({ "ace-lock": { enabled: "1" } });
  const storage = sqliteAppLockStorage(db, await readStoredLockPrefs(db));
  storage.writeEnabled(false);
  // Disk write fails: the mirror already updated (applies until restart),
  // but flush must surface the failure so the UI can notify.
  (db as unknown as { withExclusiveTransactionAsync: unknown }).withExclusiveTransactionAsync =
    async () => {
      throw new Error("disk full");
    };
  await expect(storage.flush()).rejects.toThrow("could not be saved");
  expect(storage.readEnabled()).toBe(false);
});

it("a later successful write clears the failure", async () => {
  const { db, tables } = fakeDb({ "ace-lock": { enabled: "1" } });
  let failNext = true;
  const storage = sqliteAppLockStorage(db, await readStoredLockPrefs(db));
  const real = db.withExclusiveTransactionAsync.bind(db);
  (db as unknown as { withExclusiveTransactionAsync: unknown }).withExclusiveTransactionAsync =
    async (...args: [unknown]) => {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      return (real as (...a: [unknown]) => Promise<unknown>)(...args);
    };
  storage.writeEnabled(false);
  await expect(storage.flush()).rejects.toThrow("could not be saved");
  storage.writeEnabled(true);
  await expect(storage.flush()).resolves.toBeUndefined();
  expect(tables["ace-lock"]?.["enabled"]).toBe("1");
});
