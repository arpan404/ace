import { expect, test } from "vitest";
import { expiredSnapshots, snapshotRetention, type KeptSnapshot } from "./snapshot-retention.ts";

const day = 24 * 60 * 60 * 1000;
const now = 100 * day;

function thread(key: string, used: number, settled: boolean, bytes = 1): KeptSnapshot {
  return { key, kind: "thread", used, bytes, settled };
}

test("anything unused for seven days goes, however recently it was settled or busy", () => {
  const kept = [
    thread("working", now - 7 * day, false),
    thread("settled", now - 7 * day - 1, true),
    thread("yesterday", now - day, true),
    { key: "inbox", kind: "record" as const, used: now - 8 * day, bytes: 1, settled: false },
  ];
  expect(expiredSnapshots(kept, now).toSorted()).toEqual(["inbox", "settled", "working"]);
});

test("only the twenty most recently opened settled threads are kept", () => {
  const settled = Array.from({ length: 23 }, (_, index) => thread(`s${index}`, now - index, true));
  expect(expiredSnapshots(settled, now).toSorted()).toEqual(["s20", "s21", "s22"]);
});

test("unsettled threads are kept whatever their number", () => {
  const busy = Array.from({ length: 60 }, (_, index) => thread(`w${index}`, now - index, false));
  expect(expiredSnapshots(busy, now)).toEqual([]);
});

test("past the byte cap settled threads go before anything still working, never the newest", () => {
  const policy = { ...snapshotRetention, maxBytes: 10 };
  const kept = [
    thread("newest-settled", now, true, 4),
    thread("old-settled", now - 5, true, 4),
    thread("working", now - 9, false, 4),
    { key: "inbox", kind: "record" as const, used: now - 1, bytes: 4, settled: false },
  ];
  expect(expiredSnapshots(kept, now, policy).toSorted()).toEqual(["inbox", "old-settled"]);
});
