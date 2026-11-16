import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentId, AgentItem, ItemId, type ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message } from "./payload-test-support.ts";
import { Store } from "./store.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** One database file opened by successive builds, the idle pass ticked by hand. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-trust-rows-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let current: Store | undefined;
  cleanup.push(() => current?.close());
  const state = { tick: undefined as (() => void) | undefined, finished: false };
  const open = async (shape: string, rowsPerBackfill?: number) => {
    await current?.close();
    state.finished = false;
    current = new Store(path, (error) => expect.unreachable(String(error)), {
      eventShape: shape,
      storedTrustBuild: "1.0.0",
      trustPass: {
        ...(rowsPerBackfill === undefined ? {} : { rowsPerBackfill }),
        scheduler: (run) => {
          state.tick = run;
          return () => {
            state.finished = true;
            state.tick = undefined;
          };
        },
      },
    });
    return current;
  };
  const idle = () => state.tick?.();
  const finish = () => {
    for (let guard = 0; !state.finished && guard < 1000; guard++) state.tick?.();
    expect(state.finished).toBe(true);
  };
  /** Another program's connection to the file while no store is open. */
  const raw = async (run: (db: DatabaseSync) => void) => {
    await current?.close();
    current = undefined;
    const db = new DatabaseSync(path);
    try {
      run(db);
    } finally {
      db.close();
    }
  };
  return { open, idle, finish, raw, state };
}

const sql = (store: Store, statement: string, ...values: (string | number)[]) =>
  store.atomic((db) => db.prepare(statement).run(...values));

/** Finished messages, each with a history revision, and a message still streaming in chunks. */
function history(store: Store) {
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(store, workspace).id;
  const events = store.appendEvents(
    thread,
    Array.from({ length: 12 }, (_, index) => ({
      type: "item.created" as const,
      item: message(`m${index}`),
    })),
  );
  const live = AgentItem.parse({
    id: "live",
    agentId: "root",
    type: "message",
    role: "assistant",
    complete: false,
    createdAt: 1,
    parts: [],
  });
  store.appendEvents(thread, [{ type: "item.created", item: live }]);
  for (const append of ["Hel", "lo"])
    store.appendEvents(thread, [
      {
        type: "item.delta",
        itemId: ItemId.parse("live"),
        agentId: AgentId.parse("root"),
        field: "text",
        append,
      },
    ]);
  const newest = events.at(-1)?.seq;
  if (newest === undefined) throw new Error("nothing appended");
  return { thread, newest };
}

/** What a build from before the map left: no map, its two sequence indexes, its own start. */
function beforeTheMap(db: DatabaseSync) {
  db.exec(`DROP TRIGGER stored_trust_rows_history_item_revisions_insert;
    DROP TRIGGER stored_trust_rows_history_item_revisions_delete;
    DROP TRIGGER stored_trust_rows_item_text_chunks_insert;
    DROP TRIGGER stored_trust_rows_item_text_chunks_delete;
    DROP TABLE stored_trust_rows; DROP TABLE stored_trust_rows_backfill;
    CREATE INDEX history_item_revisions_seq ON history_item_revisions(seq);
    CREATE INDEX item_text_chunks_seq ON item_text_chunks(seq);
    UPDATE stored_event_shape SET shape = 'older', first_seq = (SELECT MAX(seq) + 1 FROM events);`);
}

/**
 * Whether the event at `seq` is read as stored: drop a field validation would default, read
 * the event, and put the field back.
 */
function readAsStored(store: Store, seq: number): boolean {
  const original = store.atomic(
    (db) => db.prepare("SELECT payload FROM events WHERE seq = ?").get(seq)?.payload,
  );
  if (typeof original !== "string") throw new Error("no event at that sequence");
  sql(
    store,
    "UPDATE events SET payload = json_remove(payload, '$.item.complete') WHERE seq = ?",
    seq,
  );
  const event = store.readEvents({ afterSeq: seq - 1, limit: 1 })[0];
  sql(store, "UPDATE events SET payload = ? WHERE seq = ?", original, seq);
  if (event?.payload.type !== "item.created") throw new Error("expected an item event");
  return !("complete" in event.payload.item);
}

/** A thread's items and a revision read back; an error a validating read raises is its result. */
function outcome(read: () => unknown): string {
  try {
    return JSON.stringify(read());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
/**
 * Each kind's read on its own, so one kind's failure never hides the other: the thread's items
 * carry the streamed chunks, the completion reads m9's history revision.
 */
function snapshot(store: Store, thread: ThreadId) {
  return {
    chunks: outcome(() => store.snapshotThread(thread).items),
    revision: outcome(() => store.historicalItemCompletion(thread, "m9" as ItemId)),
  };
}
/** Every kind reads as a validating build reads it, and none as it is stored. */
function expectValidated(
  confirmed: ReturnType<typeof snapshot>,
  validating: ReturnType<typeof snapshot>,
  asStored: ReturnType<typeof snapshot>,
) {
  expect(confirmed).toEqual(validating);
  expect(confirmed.chunks).not.toBe(asStored.chunks);
  expect(confirmed.revision).not.toBe(asStored.revision);
}
/** Rewrite rows of both kinds the way validation reads differently from storage. */
function corruptRevisionAndChunk(store: Store) {
  sql(
    store,
    "UPDATE history_item_revisions SET item = json_set(json_remove(item, '$.agentId'), '$.agentId', json_extract(item, '$.agentId')) WHERE item_id = 'm9'",
  );
  sql(
    store,
    "UPDATE item_text_chunks SET append = '5' WHERE item_id = 'live' AND seq = (SELECT MAX(seq) FROM item_text_chunks)",
  );
}

it("an older home opens without indexing its history by sequence, and nothing is trusted before every older row is mapped", async () => {
  const { open, idle, finish, raw } = setup();
  const writer = await open("build A");
  const { thread, newest } = history(writer);
  corruptRevisionAndChunk(writer);
  // The writer trusts the rows it wrote, so it reads them as stored.
  const asStored = snapshot(writer, thread);
  await raw(beforeTheMap);

  const reader = await open("build B", 2);
  const indexed = reader.atomic((db) =>
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('history_item_revisions_seq', 'item_text_chunks_seq')",
      )
      .all(),
  );
  expect(indexed).toEqual([]);
  // Two rows a batch: the map takes several ticks, and no sequence is trusted meanwhile.
  for (let tick = 0; tick < 4; tick++) idle();
  expect(readAsStored(reader, newest)).toBe(false);
  finish();
  expect(readAsStored(reader, newest)).toBe(true);
  const confirmed = snapshot(reader, thread);

  // A build that trusts no older row reads every one through validation.
  const validating = await open("build C");
  expectValidated(confirmed, snapshot(validating, thread), asStored);
});

it("rows written on a home that has the map are checked by the next build", async () => {
  const { open, finish } = setup();
  const first = await open("build A");
  const { thread, newest } = history(first);
  corruptRevisionAndChunk(first);
  const asStored = snapshot(first, thread);

  const next = await open("build B");
  finish();
  expect(readAsStored(next, newest)).toBe(true);
  const confirmed = snapshot(next, thread);
  expectValidated(confirmed, snapshot(await open("build C"), thread), asStored);
});

it("an item from before raw revisions were recorded reports its creation as its raw version", async () => {
  const { open } = setup();
  const store = await open("build A");
  const { thread } = history(store);
  const recorded = store.itemRawRevision(thread, "m3");
  // What the schema step leaves on a row that existed before it.
  sql(store, "UPDATE item_heads SET raw_seq = 0 WHERE id = 'm3'");
  expect(store.itemRawRevision(thread, "m3")).toBe(recorded);

  store.appendEvents(thread, [{ type: "item.updated", item: message("m3", "changed") }]);
  expect(store.itemRawRevision(thread, "m3")).not.toBe(recorded);
});
