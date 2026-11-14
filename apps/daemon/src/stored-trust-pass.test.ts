import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Event, ItemId, ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message, shell } from "./payload-test-support.ts";
import { Store } from "./store.ts";
import { eventsPerBatch } from "./stored-trust-pass.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

interface Build {
  shape: string;
  /** What the pass's record is kept under; undefined is a development daemon. */
  build?: string | undefined;
}
const release = (shape: string, build = "1.0.0"): Build => ({ shape, build });

/**
 * Stores on one database file standing in for builds, with the idle pass ticked by hand. `open`
 * closes the previous store first; `openBeside` leaves it running, as a crash would leave it.
 */
function setup(pass: { rejectedLimit?: number; batchesPerSave?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ace-trust-pass-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const stores: Store[] = [];
  cleanup.push(() => Promise.all(stores.map((store) => store.close())));
  const errors: unknown[] = [];
  const state = { tick: undefined as (() => void) | undefined, finished: false };
  const openBeside = ({ shape, build }: Build) => {
    state.finished = false;
    const store = new Store(path, (error) => errors.push(error), {
      eventShape: shape,
      storedTrustBuild: build,
      trustPass: {
        ...pass,
        scheduler: (run) => {
          state.tick = run;
          return () => {
            state.finished = true;
            state.tick = undefined;
          };
        },
      },
    });
    stores.push(store);
    return store;
  };
  const open = async (build: Build) => {
    await stores.at(-1)?.close();
    return openBeside(build);
  };
  const idle = (ticks = 1) => {
    for (let index = 0; index < ticks; index++) state.tick?.();
  };
  const finish = () => {
    for (let guard = 0; !state.finished && guard < 1000; guard++) state.tick?.();
    expect(state.finished).toBe(true);
  };
  /** Another program's connection to the same file. */
  const raw = (run: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      run(db);
    } finally {
      db.close();
    }
  };
  return { open, openBeside, idle, finish, raw, errors, state };
}

/** A thread with more messages than one batch checks, so the pass takes several batches. */
function history(store: Store, count = eventsPerBatch + 100) {
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(store, workspace);
  const events = store.appendEvents(
    thread.id,
    Array.from({ length: count }, (_, index) => ({
      type: "item.created" as const,
      item: message(`m${index}`),
    })),
  );
  return { thread: thread.id, events };
}
function seqs(events: Event[]) {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) throw new Error("nothing appended");
  return { oldest: first.seq, newest: last.seq };
}
function at<T>(values: readonly T[], index: number): T {
  const value = values.at(index);
  if (value === undefined) throw new Error(`nothing at ${index}`);
  return value;
}

/** Every event, the newest and oldest pages of the thread's items, and its newest wire page. */
function reads(store: Store, thread: ThreadId) {
  const events = store.readEvents({ afterSeq: 0, limit: 10_000 });
  const oldest = events.find((event) => event.payload.type === "item.created")?.seq ?? 0;
  return {
    events,
    items: [
      ...store.readItems(thread, Number.MAX_SAFE_INTEGER, 200).items,
      ...store.readItems(thread, oldest + 100, 200).items,
    ],
    // Serves text items' stored previews.
    page: store.readItemPage(thread, Number.MAX_SAFE_INTEGER, 200).items,
  };
}
/** Same values in the same field order, so the same bytes on the wire. */
function expectSame(actual: unknown, expected: unknown) {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual).toStrictEqual(expected);
}

const sql = (store: Store, statement: string, ...values: (string | number)[]) =>
  store.atomic((db) => db.prepare(statement).run(...values));
/** Rewrite a stored event as an older build might have left it: without `complete`. */
function dropComplete(store: Store, seq: number) {
  sql(
    store,
    "UPDATE events SET payload = json_remove(payload, '$.item.complete') WHERE seq = ?",
    seq,
  );
}
/** Move `agentId` to the end of a stored item, as a raw `json_set` rewrite leaves it. */
function moveAgentIdLast(store: Store, table: string, where: string) {
  sql(
    store,
    `UPDATE ${table} SET item = json_set(json_remove(item, '$.agentId'), '$.agentId', json_extract(item, '$.agentId')) WHERE ${where}`,
  );
}
/**
 * Whether the event at `seq` is read as stored: change its stored JSON the way validation
 * would undo (dropping a defaulted field), read it, and put it back.
 */
function readAsStored(store: Store, seq: number): boolean {
  const original = store.atomic(
    (db) => db.prepare("SELECT payload FROM events WHERE seq = ?").get(seq)?.payload,
  );
  if (typeof original !== "string") throw new Error("no event at that sequence");
  dropComplete(store, seq);
  const event = store.readEvents({ afterSeq: seq - 1, limit: 1 })[0];
  sql(store, "UPDATE events SET payload = ? WHERE seq = ?", original, seq);
  if (event?.payload.type !== "item.created") throw new Error("expected an item event");
  return !("complete" in event.payload.item);
}
/** What a build from before the pass does at open: record its own start, nothing else. */
function prePassOpen(db: DatabaseSync, shape: string) {
  db.prepare(
    "INSERT INTO stored_event_shape VALUES (1, ?, (SELECT MAX(seq) + 1 FROM events)) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape, first_seq = excluded.first_seq",
  ).run(shape);
}

it("older rows read the same before, during and after the idle pass confirms them", async () => {
  const { open, idle, finish } = setup();
  const writer = await open(release("build A"));
  const { thread, events } = history(writer);
  const written = reads(writer, thread);
  expectSame(written.events.slice(-events.length), events);

  const reader = await open(release("build B"));
  const { oldest, newest } = seqs(events);
  expectSame(reads(reader, thread), written);
  expect(readAsStored(reader, newest)).toBe(false);

  idle();
  expectSame(reads(reader, thread), written);
  expect(readAsStored(reader, newest)).toBe(true);
  expect(readAsStored(reader, oldest)).toBe(false);

  finish();
  expectSame(reads(reader, thread), written);
  expect(readAsStored(reader, oldest)).toBe(true);
});

it("old events, items, previews and revisions validation would change stay validated, across a restart", async () => {
  const { open, finish } = setup();
  const writer = await open(release("build A"));
  const { thread, events } = history(writer, 20);
  writer.appendEvents(thread, [{ type: "item.created", item: shell("tool") }]);
  const completion = writer.historicalItemCompletion(thread, "m9" as ItemId);
  const original = reads(writer, thread);
  dropComplete(writer, at(events, 5).seq);
  moveAgentIdLast(writer, "items", "id = 'tool'");
  moveAgentIdLast(writer, "item_previews", "id = 'm7'");
  moveAgentIdLast(writer, "history_item_revisions", "item_id = 'm9'");

  const expectValidated = (store: Store) => {
    const now = reads(store, thread);
    expectSame(now.items, original.items);
    expectSame(now.page, original.page);
    expectSame(store.historicalItemCompletion(thread, "m9" as ItemId), completion);
    expect(now.events.find((event) => event.seq === at(events, 5).seq)?.payload).toMatchObject({
      item: { id: "m5", complete: true },
    });
  };
  const reader = await open(release("build B"));
  expectValidated(reader);
  finish();
  expectValidated(reader);
  expect(readAsStored(reader, at(events, 6).seq)).toBe(true);

  const restarted = await open(release("build B"));
  expectValidated(restarted);
  expect(readAsStored(restarted, at(events, 6).seq)).toBe(true);
});

it("a pass stopped without closing resumes from its last save", async () => {
  const { open, openBeside, idle, finish } = setup({ batchesPerSave: 1 });
  const writer = await open(release("build A"));
  const { thread, events } = history(writer);
  const written = reads(writer, thread);
  const { oldest, newest } = seqs(events);

  await open(release("build B"));
  idle();
  const restarted = openBeside(release("build B"));
  expect(readAsStored(restarted, newest)).toBe(true);
  expect(readAsStored(restarted, oldest)).toBe(false);

  finish();
  expect(readAsStored(restarted, oldest)).toBe(true);
  expectSame(reads(restarted, thread), written);
});

it("closing the store saves progress made since the last save", async () => {
  const { open, idle } = setup({ batchesPerSave: 1000 });
  const writer = await open(release("build A"));
  const { events } = history(writer, 10);
  await open(release("build B"));
  idle();
  const restarted = await open(release("build B"));
  expect(readAsStored(restarted, seqs(events).newest)).toBe(true);
});

it("the pass does nothing while events are being written", async () => {
  const { open, idle } = setup();
  const writer = await open(release("build A"));
  const { thread, events } = history(writer, 10);
  const { newest } = seqs(events);

  const reader = await open(release("build B"));
  for (let index = 0; index < 5; index++) {
    reader.appendEvents(thread, [{ type: "item.created", item: message(`live${index}`) }]);
    idle();
  }
  expect(readAsStored(reader, newest)).toBe(false);
  idle();
  expect(readAsStored(reader, newest)).toBe(true);
});

it("the pass does nothing while a run is in progress, a transaction is open or history is published", async () => {
  const { open, idle } = setup();
  const writer = await open(release("build A"));
  const { thread, events } = history(writer, 10);
  const { newest } = seqs(events);

  const reader = await open(release("build B"));
  sql(
    reader,
    "UPDATE threads SET status = ? WHERE id = ?",
    '{"state":"working","agents":1}',
    thread,
  );
  idle(3);
  expect(readAsStored(reader, newest)).toBe(false);
  sql(reader, "UPDATE threads SET status = ? WHERE id = ?", '{"state":"done"}', thread);

  reader.atomic(() => idle(3));
  expect(readAsStored(reader, newest)).toBe(false);
  reader.setHistoryWriting(true);
  idle(3);
  expect(readAsStored(reader, newest)).toBe(false);
  reader.setHistoryWriting(false);

  idle(2);
  expect(readAsStored(reader, newest)).toBe(true);
});

it("rows a build without the pass rewrote in between are decoded again, even under the same shape", async () => {
  const { open, finish, raw } = setup();
  const writer = await open(release("build A"));
  const { events } = history(writer, 10);
  const { oldest } = seqs(events);

  const verifier = await open(release("build B"));
  finish();
  await verifier.close();
  raw((db) => {
    prePassOpen(db, "build without the pass");
    db.prepare(
      "UPDATE events SET payload = json_remove(payload, '$.item.complete') WHERE seq = ?",
    ).run(oldest);
    prePassOpen(db, "build B");
  });
  const back = await open(release("build B"));
  const event = back.readEvents({ afterSeq: oldest - 1, limit: 1 })[0];
  expect(event?.payload).toMatchObject({ item: { complete: true } });
});

it("an open interrupted while it resets trust leaves the previous record whole", async () => {
  const { open, finish, raw } = setup();
  const writer = await open(release("build A"));
  const { events } = history(writer, 10);
  const changed = at(events, 4);
  dropComplete(writer, changed.seq);

  const verifier = await open(release("build B"));
  finish();
  await verifier.close();
  raw((db) =>
    db.exec(
      "CREATE TRIGGER interrupted BEFORE DELETE ON stored_event_confirmed BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
    ),
  );
  await expect(open(release("build C"))).rejects.toThrow("interrupted");
  raw((db) => {
    db.exec("DROP TRIGGER interrupted");
    prePassOpen(db, "build B");
  });
  const back = await open(release("build B"));
  const event = back.readEvents({ afterSeq: changed.seq - 1, limit: 1 })[0];
  expect(event?.payload).toMatchObject({ item: { complete: true } });
});

it("a running pass drops its trust when another build records its start between batches", async () => {
  const { open, idle, raw } = setup();
  const writer = await open(release("build A"));
  const { events } = history(writer);
  const { newest } = seqs(events);

  const reader = await open(release("build B"));
  idle();
  expect(readAsStored(reader, newest)).toBe(true);
  raw((db) => {
    prePassOpen(db, "build T");
    db.prepare(
      "UPDATE events SET payload = json_remove(payload, '$.item.complete') WHERE seq = ?",
    ).run(newest);
  });
  idle();
  const event = reader.readEvents({ afterSeq: newest - 1, limit: 1 })[0];
  expect(event?.payload).toMatchObject({ item: { complete: true } });
});

it("a new release checks again, and a development daemon keeps nothing it confirmed", async () => {
  const { open, finish } = setup();
  const writer = await open(release("build A"));
  const { oldest } = seqs(history(writer, 10).events);

  await open(release("build B", "1.0.0"));
  finish();
  expect(readAsStored(await open(release("build B", "1.0.0")), oldest)).toBe(true);
  expect(readAsStored(await open(release("build B", "1.0.1")), oldest)).toBe(false);

  await open({ shape: "build C" });
  finish();
  expect(readAsStored(await open({ shape: "build C" }), oldest)).toBe(false);
});

it("a malformed old event is rejected and the pass goes on below it", async () => {
  const { open, finish } = setup();
  const writer = await open(release("build A"));
  const { events } = history(writer, 10);
  sql(writer, "UPDATE events SET payload = 'not json' WHERE seq = ?", at(events, 5).seq);

  const reader = await open(release("build B"));
  finish();
  expect(readAsStored(reader, at(events, 4).seq)).toBe(true);
  expect(() => reader.readEvents({ afterSeq: at(events, 5).seq - 1, limit: 1 })).toThrow();
});

it("a batch checks a bounded number of bytes, and an oversized row stays validated", async () => {
  const { open, idle, finish } = setup();
  const writer = await open(release("build A"));
  const { events } = history(writer, 10);
  const inflate = (seq: number, bytes: number) =>
    sql(
      writer,
      "UPDATE events SET payload = json_set(payload, '$.item.parts[0].text', ?) WHERE seq = ?",
      "x".repeat(bytes),
      seq,
    );
  for (const event of events.slice(-6)) inflate(event.seq, 300_000);
  inflate(at(events, 1).seq, 1_200_000);

  const reader = await open(release("build B"));
  idle();
  expect(readAsStored(reader, at(events, -1).seq)).toBe(true);
  expect(readAsStored(reader, at(events, -5).seq)).toBe(false);
  finish();
  expect(readAsStored(reader, at(events, -5).seq)).toBe(true);
  expect(readAsStored(reader, at(events, 1).seq)).toBe(false);
  expect(readAsStored(reader, at(events, 0).seq)).toBe(true);
});

it("the pass stops extending trust at the rejection limit", async () => {
  const { open, finish } = setup({ rejectedLimit: 2 });
  const writer = await open(release("build A"));
  const { events } = history(writer, 10);
  for (const index of [2, 4, 6]) dropComplete(writer, at(events, index).seq);

  const reader = await open(release("build B"));
  finish();
  expect(readAsStored(reader, at(events, 8).seq)).toBe(false);
});

it("an error that isn't contention stops the pass and is reported once", async () => {
  const { open, idle, errors, state } = setup();
  const writer = await open(release("build A"));
  history(writer, 10);
  const reader = await open(release("build B"));
  sql(reader, "DROP TABLE item_previews");
  idle(5);
  expect(errors).toHaveLength(1);
  expect(state.finished).toBe(true);
});
