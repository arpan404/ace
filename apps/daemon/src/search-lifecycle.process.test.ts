import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Store } from "./index.ts";

test("a scheduler startup failure releases the store database", () => {
  const db = new DatabaseSync(":memory:");
  expect(
    () =>
      new Store(":memory:", () => {}, {
        database: db,
        searchScheduler: () => {
          throw new Error("scheduler unavailable");
        },
      }),
  ).toThrow("scheduler unavailable");
  expect(db.isOpen).toBe(false);
});

test("a scheduler cancellation failure closes the database and reports failed cleanup", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", () => {}, {
    database: db,
    searchScheduler: () => () => {
      throw new Error("cancel failed");
    },
  });
  await expect(store.close()).rejects.toThrow("cancel failed");
  expect(db.isOpen).toBe(false);
  await expect(store.close()).rejects.toThrow("cancel failed");
});

test("reentrant scheduler cancellation still closes the store once and releases its database", async () => {
  const db = new DatabaseSync(":memory:");
  let reentrant: Promise<void> | undefined;
  const store = new Store(":memory:", () => {}, {
    database: db,
    searchScheduler: () => () => {
      reentrant = store.close();
    },
  });
  await store.close();
  await reentrant;
  expect(db.isOpen).toBe(false);
});
