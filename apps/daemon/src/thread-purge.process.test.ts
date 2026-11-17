import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentId, Item, Thread, type EventPayload, type ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";
import { StorageJournal } from "./storage/journal.ts";
import { purgeThread, resumePurges, threadGone, type PurgePace } from "./thread-gone.ts";

/*
 * Purging a large thread (ADR 0177) is a run of short writes the daemon can serve between, never
 * one long write that holds the store; one cut short is finished after a restart, and the thread
 * reads as gone throughout.
 */

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A store in a new home, or `reopened` again as a restart opens it. */
function open(reopened?: string) {
  const home = reopened ?? mkdtempSync(join(tmpdir(), "ace-purge-"));
  if (!homes.includes(home)) homes.push(home);
  const store = new Store(join(home, "events.sqlite"));
  stores.push(store);
  // Storage's journal holds the purge's progress and its record.
  const journal = new StorageJournal(store);
  return { home, store, journal };
}

function thread(
  { store, home }: { store: Store; home: string },
  id: string,
  items: number,
): ThreadId {
  const workspace = store.createWorkspace(join(home, id), id);
  const created = Thread.parse({
    id,
    workspaceId: workspace,
    title: id,
    provider: "codex",
    status: { state: "done" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(created.id, [{ type: "thread.created", thread: created }], 1);
  for (let from = 0; from < items; from += 250) {
    const page: EventPayload[] = [];
    for (let index = from; index < Math.min(items, from + 250); index++)
      page.push({
        type: "item.created",
        item: Item.parse({
          type: "message",
          id: `item-${index}`,
          agentId: AgentId.parse("root"),
          createdAt: 1,
          complete: true,
          role: "assistant",
          parts: [{ type: "text", text: `Line ${index} ${"x".repeat(200)}` }],
        }),
      });
    store.appendEvents(created.id, page, 1);
  }
  return created.id;
}

const tombstone = (store: Store, id: ThreadId) =>
  store.appendEvents(id, [{ type: "thread.client.updated", changes: { deletedAt: 2 } }], 2);

const rows = (store: Store, table: string, id: ThreadId) =>
  Number(store.statement(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id=?`).get(id)?.n);

test("purging a large thread writes a batch at a time, other writers go in between, and it reads as gone throughout", async () => {
  const opened = open();
  const { store } = opened;
  const big = thread(opened, "big", 3000);
  const other = thread(opened, "other", 0);
  tombstone(store, big);
  const before = rows(store, "events", big);
  expect(before).toBeGreaterThan(3000);

  let pauses = 0;
  const pace: PurgePace = {
    batch: 200,
    async idle() {
      pauses++;
      // Another thread's write, between two of the purge's: never held behind the whole purge.
      store.appendEvents(other, [{ type: "thread.updated", title: `Other ${pauses}` }], 3);
      expect(threadGone((id) => store.getThread(id), undefined, big)).toBe(true);
    },
    going: () => true,
  };
  expect(await purgeThread(store, big, 3, pace)).toBe(true);

  // Every batch is bounded: the transcript went in many writes, not one.
  expect(pauses).toBeGreaterThan(before / 200);
  expect(store.getThread(other)?.title).toBe(`Other ${pauses}`);
  expect(rows(store, "events", big)).toBe(0);
  expect(rows(store, "items", big)).toBe(0);
  expect(store.statement("SELECT 1 FROM storage_purged WHERE thread_id=?").get(big)).toBeDefined();
  expect(store.statement("SELECT 1 FROM thread_purges").get()).toBeUndefined();
  // The tombstone stays, so whatever still names it reads it as gone.
  expect(store.getThread(big)?.deletedAt).toBe(2);
});

test("a purge cut short is finished after a restart", async () => {
  const first = open();
  const big = thread(first, "big", 1000);
  tombstone(first.store, big);
  let batches = 0;
  const stopping: PurgePace = {
    batch: 100,
    idle: async () => {
      batches++;
    },
    going: () => batches < 3,
  };
  expect(await purgeThread(first.store, big, 3, stopping)).toBe(false);
  expect(rows(first.store, "events", big)).toBeGreaterThan(0);
  expect(first.store.getThread(big)?.deletedAt).toBe(2);
  first.store.close();
  stores.splice(stores.indexOf(first.store), 1);

  const { store } = open(first.home);
  const finished: ThreadId[] = [];
  await resumePurges(
    store,
    () => 4,
    { batch: 100, idle: async () => {}, going: () => true },
    (id) => finished.push(id),
  );
  expect(finished).toEqual([big]);
  expect(rows(store, "events", big)).toBe(0);
  expect(store.statement("SELECT 1 FROM storage_purged WHERE thread_id=?").get(big)).toBeDefined();
});
