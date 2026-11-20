import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { afterEach, expect, test } from "vitest";
import { openWhileBusy } from "./busy-open.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A database another connection holds an exclusive lock on, as a killed daemon's leftover would. */
function lockedDatabase() {
  const home = mkdtempSync(join(tmpdir(), "ace-busy-open-"));
  homes.push(home);
  const path = join(home, "events.sqlite");
  const holder = new DatabaseSync(path);
  holder.exec("CREATE TABLE t (x INTEGER); BEGIN EXCLUSIVE; INSERT INTO t VALUES (1)");
  const open = () => {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; INSERT INTO t VALUES (2); COMMIT");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  return { holder, open };
}

test("a store held busy at startup opens once the holder lets go, after backing off", async () => {
  const { holder, open } = lockedDatabase();
  const waits: number[] = [];
  const db = await openWhileBusy(
    open,
    {
      sleep: async (delayMs) => {
        waits.push(delayMs);
        // The holder (a killed daemon's leftover) goes away during the second wait.
        if (waits.length === 2) holder.exec("ROLLBACK");
      },
      onBusy: () => {},
    },
    [10, 20, 40],
  );
  expect(waits).toEqual([10, 20]);
  expect(db.prepare("SELECT count(*) AS n FROM t").get()?.["n"]).toBe(1);
  db.close();
  holder.close();
});

test("a store held busy past the whole schedule fails the start with the lock error", async () => {
  const { holder, open } = lockedDatabase();
  const retries: number[] = [];
  await expect(
    openWhileBusy(
      open,
      { sleep: async () => {}, onBusy: (attempt) => retries.push(attempt) },
      [1, 1],
    ),
  ).rejects.toThrow(/locked/);
  expect(retries).toEqual([1, 2]);
  holder.close();
});

test("a failure other than a busy lock is not retried", async () => {
  let attempts = 0;
  await expect(
    openWhileBusy(
      () => {
        attempts++;
        throw new Error("file is not a database");
      },
      { sleep: async () => {}, onBusy: () => {} },
    ),
  ).rejects.toThrow("file is not a database");
  expect(attempts).toBe(1);
});
