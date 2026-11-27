import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Thread, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { schemaVersionBefore } from "./migrations.ts";
import {
  createThreads,
  snapshot,
  threadStream,
  withoutRevision,
  type Assertions,
} from "./store-cross-test-support.ts";
import { undoMachineCode } from "./upgrade-test-support.ts";
import { threadColdTable } from "./thread-cold.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const assertions: Assertions = {
  equal: (actual, expected, label) => expect(actual, label).toEqual(expected),
  strictEqual: (actual, expected, label) => expect(actual, label).toStrictEqual(expected),
  throws: (run, message) => expect(run).toThrow(message),
};

function open(path: string) {
  const db = new DatabaseSync(path);
  const store = new Store(path, () => {}, { database: db });
  return { db, store };
}

test("a status change is stored with its sequence, so a reloaded thread still reads as unread", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-activity-seq-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  let { store } = open(path);
  const id = ThreadId.parse("activity-thread");
  store.appendEvents(id, [
    {
      type: "thread.created",
      thread: Thread.parse({
        id,
        workspaceId: store.createWorkspace(dir, "Project"),
        title: "Task",
        provider: "codex",
        status: { state: "new" },
        createdAt: 1,
        updatedAt: 1,
        hasSentMessage: true,
      }),
    },
  ]);
  const [done] = store.appendEvents(id, [{ type: "thread.updated", status: { state: "done" } }]);
  if (!done) throw new Error("Missing event");
  // A device that read up to before this change compares its cursor with activitySeq.
  expect(store.getThread(id)?.activitySeq).toBe(done.seq);
  store.close();
  ({ store } = open(path));
  try {
    expect(store.getThread(id)?.activitySeq).toBe(done.seq);
    const entry = store.sidebarPage({ limit: 10 }).threads.find((thread) => thread.id === id);
    expect(entry?.activitySeq).toBe(done.seq);
  } finally {
    store.close();
  }
});

test("a long random event stream reads the same from cache, after a restart and after an upgrade", () => {
  for (const seed of [11, 12, 13]) runSeed(seed);
});

function runSeed(seed: number) {
  const dir = mkdtempSync(join(tmpdir(), "ace-thread-columns-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  let { db, store } = open(path);
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      /* Closed by the test already. */
    }
  });
  const state = createThreads(store, dir, seed, 10);
  const { ids } = state;
  const stream = threadStream(store, db, state, assertions);
  stream.check(`seed ${seed}, start`, new Set());
  for (let step = 1; step <= 300; step++) stream.step(`seed ${seed}, step ${step}`);
  const { windows } = stream;

  const before = snapshot(store, windows);
  const detailed = before.threads.filter((thread) => thread.details !== undefined).length;
  const capable = before.threads.filter((thread) => thread.capabilities !== undefined).length;
  expect(detailed).toBeGreaterThan(0);
  expect(capable).toBeGreaterThan(0);

  // A restart reads every thread and window back the same.
  store.close();
  ({ db, store } = open(path));
  expect(snapshot(store, windows), `seed ${seed}, restart`).toStrictEqual(before);
  for (const thread of before.threads) expect(store.getThread(thread.id)).toStrictEqual(thread);
  store.close();

  // A database from before thread_cold kept details in client and capabilities in
  // provider_metadata. Upgrading it moves them out and reads every thread the same.
  const old = new DatabaseSync(path);
  old.exec(`
    ${undoMachineCode}
    UPDATE threads SET client = json_set(COALESCE(client, '{}'), '$.details', json(cold.details))
      FROM thread_cold AS cold WHERE cold.thread_id = threads.id AND cold.details IS NOT NULL;
    UPDATE threads SET provider_metadata = json_set(COALESCE(provider_metadata, '{}'), '$.capabilities', json(cold.capabilities))
      FROM thread_cold AS cold WHERE cold.thread_id = threads.id AND cold.capabilities IS NOT NULL;
    DROP TRIGGER thread_cold_owner_delete;
    DROP TRIGGER thread_cold_owner_rekey;
    DROP TABLE thread_cold;
    DROP TABLE thread_cold_moved;
    -- The schema before thread_cold had no machine_children columns from later steps; those
    -- steps add them again.
    DROP TABLE IF EXISTS machine_children;
    UPDATE schema_version SET version = ${schemaVersionBefore(threadColdTable)} WHERE id = 1;
  `);
  old.close();
  ({ db, store } = open(path));
  // Moving the values rewrites each thread's row, so each takes a new row revision and a list
  // resuming from before the upgrade rereads them. Everything else reads the same.
  const upgraded = snapshot(store, windows);
  expect(withoutRevision(upgraded), `seed ${seed}, upgrade`).toStrictEqual(withoutRevision(before));
  upgraded.sidebar.forEach((page, index) =>
    expect(page.window.revision, `seed ${seed}, upgrade revision`).toBeGreaterThan(
      before.sidebar[index]?.window.revision ?? Infinity,
    ),
  );
  for (const thread of before.threads) expect(store.getThread(thread.id)).toStrictEqual(thread);
  const stored = db
    .prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE json_type(client, '$.details') IS NOT NULL OR json_type(provider_metadata, '$.capabilities') IS NOT NULL",
    )
    .get();
  expect(stored?.n).toBe(0);
  const cold = db
    .prepare(
      "SELECT COUNT(details) AS details, COUNT(capabilities) AS capabilities FROM thread_cold",
    )
    .get();
  expect(cold).toEqual({ details: detailed, capabilities: capable });
  // And it keeps working: an event after the upgrade reads back the same both ways.
  const id = ids[0];
  if (!id) throw new Error("Missing thread");
  store.appendEvents(id, [{ type: "thread.client.updated", changes: { pinned: true } }]);
  expect(store.getThread(id)).toStrictEqual(store.listThreads().find((thread) => thread.id === id));
  expect(store.getThread(id)?.details).toStrictEqual(
    before.threads.find((thread) => thread.id === id)?.details,
  );
  store.close();
}
