import { expect, test } from "vitest";
import { nextStorageState, roomyStorage, type StorageLevels } from "./storage-levels.ts";

const levels: StorageLevels = { pauseBelow: 100, resumeAt: 200, warnBelow: 400 };
const full = { full: true, low: true };

test.each([
  ["plenty of room stays roomy", roomyStorage, 1_000, roomyStorage],
  ["under the warning level only warns", roomyStorage, 300, { full: false, low: true }],
  ["under the pause level holds new work", roomyStorage, 99, full],
  ["a held disk with a little room back stays held", full, 150, full],
  ["a held disk released at the resume level", full, 200, { full: false, low: true }],
  ["a held disk with plenty of room is fully roomy", full, 1_000, roomyStorage],
])("%s", (_name, state, bytes, expected) => {
  expect(nextStorageState(state, { kind: "free", bytes }, levels)).toEqual(expected);
});

test("a write that failed for want of space holds new work whatever free space last read", () => {
  expect(nextStorageState(roomyStorage, { kind: "write-failed" }, levels)).toMatchObject(full);
});

test("a hold a refused write began lifts on a probe write that succeeds, never on free space alone", () => {
  const refused = nextStorageState(full, { kind: "write-failed" }, levels);
  // A quota is invisible to free space: plenty of room reads, and the hold stays.
  expect(nextStorageState(refused, { kind: "free", bytes: 1_000 }, levels).full).toBe(true);
  expect(nextStorageState(refused, { kind: "probe", ok: false, bytes: 1_000 }, levels).full).toBe(
    true,
  );
  expect(nextStorageState(refused, { kind: "probe", ok: true, bytes: 1_000 }, levels)).toEqual(
    roomyStorage,
  );
  // A probe that succeeds with too little room on the volume still leaves new work held.
  expect(nextStorageState(refused, { kind: "probe", ok: true, bytes: 150 }, levels)).toEqual(full);
});

test("unreadable free space changes nothing", () => {
  expect(nextStorageState(full, { kind: "free", bytes: null }, levels)).toEqual(full);
  expect(nextStorageState(roomyStorage, { kind: "free", bytes: null }, levels)).toEqual(
    roomyStorage,
  );
});
