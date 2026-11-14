import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { rawEntriesQuery } from "./item-store.ts";
import { migrate } from "./migrations.ts";

// A page of raw payloads is read by stepping one query until the page is full. If SQLite had to
// sort or buffer the entries first, every page of a large item would walk all that remain
// before the first came back: the plan must stream them.
test("reading an item's raw payloads streams them in order, with no sort or temporary b-tree", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${rawEntriesQuery}`)
    .all("$.raw", "item", "thread", 0)
    .map((row) => String(row.detail));
  expect(plan.some((step) => /TEMP B-TREE|SORT/i.test(step))).toBe(false);
  expect(plan.some((step) => /SEARCH i USING .*INDEX/.test(step))).toBe(true);
});
