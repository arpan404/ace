import type { ReadSnapshotStorage } from "@ace/client";
import { expect, test } from "vitest";
import { turnStepsStoreIn } from "./kept-turn-steps.ts";

/** One connection's read snapshots, in memory and through JSON as IndexedDB's would be. */
function snapshots() {
  const records = new Map<string, string>();
  const storage: ReadSnapshotStorage = {
    async get(key) {
      const text = records.get(key);
      return text === undefined ? undefined : JSON.parse(text);
    },
    async set(key, value) {
      records.set(key, JSON.stringify(value));
    },
  };
  return async () => storage;
}

const record = { version: 1, steps: [] };

// Mutation: reading a record another build wrote.
test("a turn kept by another build is a miss; the same build reads it back", async () => {
  const storage = snapshots();
  await turnStepsStoreIn(storage, { hostId: "mac", build: "1" }).set("t/1", record);
  expect(await turnStepsStoreIn(storage, { hostId: "mac", build: "2" }).get("t/1")).toBeUndefined();
  expect(await turnStepsStoreIn(storage, { hostId: "mac", build: "1" }).get("t/1")).toEqual(record);
});

// Mutation: filing records without the daemon that answered.
test("a turn kept for one daemon is a miss for another at the same address", async () => {
  const storage = snapshots();
  await turnStepsStoreIn(storage, { hostId: "old", build: "1" }).set("t/1", record);
  expect(await turnStepsStoreIn(storage, { hostId: "new", build: "1" }).get("t/1")).toBeUndefined();
});

test("a browser without storage keeps nothing and misses", async () => {
  const store = turnStepsStoreIn(async () => undefined, { hostId: "mac", build: "1" });
  await store.set("t/1", record);
  expect(await store.get("t/1")).toBeUndefined();
});
