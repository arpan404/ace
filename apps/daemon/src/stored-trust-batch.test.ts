import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message } from "./payload-test-support.ts";
import { Store } from "./store.ts";
import { trustedFrom } from "./stored-decode.ts";
import { verifyStoredBatch } from "./stored-trust-batch.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** A store file holding one thread of messages with the given text sizes, oldest first. */
async function written(sizes: number[]) {
  const home = mkdtempSync(join(tmpdir(), "ace-trust-batch-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const store = new Store(path, console.error, { trustPass: { scheduler: () => () => {} } });
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(store, workspace);
  const events = store.appendEvents(
    thread.id,
    sizes.map((size, index) => ({
      type: "item.created" as const,
      item: message(`m${index}`, "x".repeat(size)),
    })),
  );
  await store.close();
  return { path, seqs: events.map((event) => event.seq) };
}

/** A connection that counts the bytes of every text value SQLite hands back to JavaScript. */
function counting(path: string) {
  const db = new DatabaseSync(path);
  cleanup.push(() => db.close());
  const read = { bytes: 0 };
  const count = (row: unknown) => {
    if (typeof row !== "object" || row === null) return row;
    for (const value of Object.values(row))
      if (typeof value === "string") read.bytes += value.length;
    return row;
  };
  const wrap = (statement: StatementSync): StatementSync =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "get") return (...values: never[]) => count(target.get(...values));
        if (key === "all") return (...values: never[]) => target.all(...values).map(count);
        if (key === "iterate")
          return function* (...values: never[]) {
            for (const row of target.iterate(...values)) yield count(row);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted, read };
}

const budget = 64 * 1024;

it("a batch loads no more stored JSON than its budget", async () => {
  // A 10 KB message weighs about 29 KB: its event, items row, preview and revision. Two fit
  // 72 KiB; the third's event still fits, its other rows don't.
  const { path, seqs } = await written(Array.from({ length: 12 }, () => 10_000));
  const { db, read } = counting(path);
  const head = Math.max(...seqs);
  const batch = verifyStoredBatch(db, trustedFrom(head + 1), 512, 72 * 1024);
  expect(read.bytes).toBeLessThanOrEqual(72 * 1024);
  expect(batch?.rejected).toEqual([]);
  // Cut by the budget: the oldest messages are left for the next batch.
  expect(batch?.from).toBeGreaterThan(Math.min(...seqs));
});

it("a sequence whose rows together exceed the budget is rejected without loading them", async () => {
  // About 40 KiB in the event and 40 KiB in the items row: neither alone exceeds 64 KiB.
  const { path, seqs } = await written([100, 40_000]);
  const { db, read } = counting(path);
  const [small, large] = seqs;
  if (small === undefined || large === undefined) throw new Error("nothing appended");
  const batch = verifyStoredBatch(db, trustedFrom(large + 1), 512, budget);
  expect(batch?.rejected).toEqual([large]);
  expect(batch?.from).toBe(0);
  expect(read.bytes).toBeLessThan(10_000);
});

it("an event over the budget is rejected from its size alone, its body never loaded", async () => {
  const { path, seqs } = await written([100, 80_000]);
  const { db, read } = counting(path);
  const large = Math.max(...seqs);
  db.prepare("UPDATE events SET payload = ? WHERE seq = ?").run(`{${"x".repeat(80_000)}`, large);
  const batch = verifyStoredBatch(db, trustedFrom(large + 1), 512, budget);
  expect(batch?.rejected).toEqual([large]);
  expect(read.bytes).toBeLessThan(10_000);
});
