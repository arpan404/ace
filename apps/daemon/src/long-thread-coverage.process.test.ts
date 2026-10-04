import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { ThreadSearchRequest, type EventPayload } from "@ace/protocol";
import { storeFixture, agentMessage, start, turns } from "./long-thread-test-support.ts";

// Mutations: reporting search readiness from FTS coverage alone; losing progress when the
// turn index has not yet replayed old history. Not executed (tests run at merge).
test("search exposes incomplete turn coverage after upgrading a database with existing FTS history", async () => {
  const f = storeFixture();
  start(f.store, f.thread, "coverage-turn", 20);
  f.store.appendEvents(
    f.thread.id,
    Array.from({ length: 600 }, (_, index): EventPayload => ({
      type: "item.created",
      item: agentMessage(`coverage-${index}`, `Coverage message ${index}`, "coverage-turn"),
    })),
    30,
  );
  while (f.store.search.flush(256) > 0) {
    /* Finish old FTS work before the simulated upgrade. */
  }
  const query = ThreadSearchRequest.parse({
    type: "thread.search",
    requestId: "coverage",
    threadId: f.thread.id,
    text: "Coverage",
    limit: 3,
  });
  expect(f.store.threadSearch(query).ready).toBe(true);
  await f.store.close();
  // Persist the pre-feature database state: canonical history and search exist, while the
  // new derived long-thread tables have never been installed. This is a SQLite upgrade edge.
  const legacy = new DatabaseSync(join(f.home, "events.sqlite"));
  try {
    const tables = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'long_%'")
      .all();
    for (const table of tables) {
      const name = String(table.name);
      if (!/^long_[a-z_]+$/.test(name)) throw new Error("Invalid legacy fixture table");
      legacy.exec(`DROP TABLE "${name}"`);
    }
  } finally {
    legacy.close();
  }
  await f.restart();
  const partial = f.store.threadSearch(query);
  expect(partial.hits).toHaveLength(3);
  expect(partial.ready).toBe(false);
  expect(partial.indexedSeq).toBeLessThan(partial.headSeq);
  while (!turns(f.store, f.thread).ready) await setImmediate();
  const completed = f.store.threadSearch(query);
  expect(completed.ready).toBe(true);
  expect(completed.indexedSeq).toBe(completed.headSeq);
  expect(completed.hits.every((hit) => hit.turnOrdinal === 1)).toBe(true);
});

// Mutations: reporting readiness from a caught-up turn index while FTS replay remains
// paused. Not executed (tests run at merge).
test("search stays incomplete during FTS replay even when turn summaries are already indexed", async () => {
  const f = storeFixture();
  start(f.store, f.thread, "coverage-turn", 20);
  f.store.appendEvents(
    f.thread.id,
    Array.from({ length: 600 }, (_, index): EventPayload => ({
      type: "item.created",
      item: agentMessage(`fts-coverage-${index}`, `Coverage output ${index}`, "coverage-turn"),
    })),
    30,
  );
  while (f.store.search.flush(256) > 0) {
    /* Finish pending text indexing. */
  }
  expect(turns(f.store, f.thread).ready).toBe(true);
  const paused = Promise.withResolvers<void>();
  const rebuild = f.store.search.rebuild(f.store, {
    signal: new AbortController().signal,
    yield: () => paused.promise,
  });
  try {
    const query = ThreadSearchRequest.parse({
      type: "thread.search",
      requestId: "paused-fts",
      threadId: f.thread.id,
      text: "Coverage",
      limit: 3,
    });
    const partial = f.store.threadSearch(query);
    expect(partial.ready).toBe(false);
    expect(partial.indexedSeq).toBeLessThan(partial.headSeq);
    paused.resolve();
    await rebuild;
    const completed = f.store.threadSearch(query);
    expect(completed.ready).toBe(true);
    expect(completed.hits).toHaveLength(3);
  } finally {
    paused.resolve();
    await rebuild;
  }
});
