import { expect, test } from "vitest";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { timeOrderedIds } from "./time-ordered-id.ts";

/** The first 48 bits of a UUIDv7 are its Unix millisecond timestamp. */
const millis = (id: string) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

test("ids sort in creation order within a millisecond, after a full counter and a clock step back", () => {
  const clock = [5_000, 5_000, 5_000, 4_000, 6_000];
  let tick = 0;
  // Worst-case randomness: every counter starts at its highest seed and tails are all ones.
  const next = timeOrderedIds(
    () => clock[Math.min(tick++, clock.length - 1)] ?? 0,
    (bytes) => new Uint8Array(bytes).fill(0xff),
  );
  const ids = Array.from({ length: 5000 }, () => next());
  expect(ids.toSorted()).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
  // A clock that steps back never produces an id older than one already issued.
  expect(Math.min(...ids.slice(3).map(millis))).toBeGreaterThanOrEqual(5_000);
});

test("ids are RFC 9562 version 7 UUIDs that carry their creation time", () => {
  const next = timeOrderedIds(() => Date.UTC(2026, 9, 19));
  const id = next();
  expect(z.uuid().safeParse(id).success).toBe(true);
  expect(id[14]).toBe("7");
  expect(["8", "9", "a", "b"]).toContain(id[19]);
  expect(millis(id)).toBe(Date.UTC(2026, 9, 19));
});

test("rows keyed by time-ordered ids are appended to the end of their index", () => {
  const next = timeOrderedIds();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rows (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO rows VALUES (?, ?)");
  for (let n = 0; n < 2000; n++) insert.run(next(), n);
  const order = db
    .prepare("SELECT n FROM rows ORDER BY id")
    .all()
    .map((row) => Number(row.n));
  expect(order).toEqual(Array.from({ length: 2000 }, (_, n) => n));
  db.close();
});
