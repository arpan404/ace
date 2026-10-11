import { DatabaseSync } from "node:sqlite";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { expect, test } from "vitest";
import { Records, RecordBudget } from "./records.ts";

const thread = ThreadId.parse("cache-thread");
const schema = z.object({ text: z.string() });
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE engine_state_records(thread_id TEXT, section TEXT, key TEXT, value TEXT, PRIMARY KEY(thread_id,section,key)); CREATE TABLE engine_state_appends(id INTEGER PRIMARY KEY, thread_id TEXT, section TEXT, key TEXT, patch TEXT)",
  );
  const budget = new RecordBudget();
  const section = (name: string) =>
    new Records(db, thread, name, schema, {}, undefined, undefined, budget);
  const put = (name: string, text: string) =>
    db
      .prepare("INSERT OR REPLACE INTO engine_state_records VALUES(?,?,?,?)")
      .run(thread, name, "item", JSON.stringify({ text }));
  return { db, section, put };
}

test("records from separate snapshot sections share a bounded cache and evicted records reload", () => {
  const h = fixture();
  try {
    const first = h.section("first"),
      second = h.section("second"),
      third = h.section("third");
    const text = "x".repeat(1_000_000);
    for (const name of ["first", "second", "third"]) h.put(name, text);
    expect(first.values.item?.text.length).toBe(text.length);
    h.put("first", "reloaded after eviction");
    expect(second.values.item?.text.length).toBe(text.length);
    expect(third.values.item?.text.length).toBe(text.length);
    expect(first.values.item?.text).toBe("reloaded after eviction");
  } finally {
    h.db.close();
  }
});

test("appended text counts against the cache budget and survives eviction and replacement", () => {
  const h = fixture();
  try {
    const records = h.section("items");
    h.put("items", "x".repeat(1_000_000));
    expect(records.values.item?.text.length).toBe(1_000_000);
    records.append("item", { path: ["text"], text: "y".repeat(1_200_000) });
    expect(records.values.item?.text.length).toBe(2_200_000);
    h.put("items", "reloaded");
    h.db.prepare("DELETE FROM engine_state_appends").run();
    expect(records.values.item?.text).toBe("reloaded");
  } finally {
    h.db.close();
  }
});
