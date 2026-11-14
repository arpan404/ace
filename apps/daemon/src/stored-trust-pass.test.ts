import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message } from "./payload-test-support.ts";
import { Store } from "./store.ts";
import { trustedSequenceStart } from "./stored-shape.ts";
import { eventsPerBatch } from "./stored-trust-pass.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/**
 * A store whose event shape the test chooses, standing in for builds, with the idle pass ticked
 * by hand one batch per tick.
 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-trust-pass-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store: Store | undefined;
  let tick: (() => void) | undefined;
  const pass = { finished: false };
  const open = (eventShape: string) => {
    store?.close();
    pass.finished = false;
    store = new Store(path, console.error, {
      eventShape,
      trustPass: {
        batchesPerTick: 1,
        scheduler: (run) => {
          tick = run;
          return () => {
            pass.finished = true;
            tick = undefined;
          };
        },
      },
    });
    return store;
  };
  cleanup.push(() => store?.close());
  const idle = (ticks = 1) => {
    for (let index = 0; index < ticks; index++) tick?.();
  };
  const finish = () => {
    for (let guard = 0; !pass.finished && guard < 1000; guard++) tick?.();
    expect(pass.finished).toBe(true);
  };
  return { open, idle, finish, pass };
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

/** Every event, and the newest and oldest pages of the thread's items. */
function reads(store: Store, thread: ThreadId) {
  const events = store.readEvents({ afterSeq: 0, limit: 10_000 });
  const oldest = events.find((event) => event.payload.type === "item.created")?.seq ?? 0;
  return {
    events,
    items: [
      ...store.readItems(thread, Number.MAX_SAFE_INTEGER, 200).items,
      ...store.readItems(thread, oldest + 100, 200).items,
    ],
  };
}
/** Same values in the same field order, so the same bytes on the wire. */
function expectSame(actual: unknown, expected: unknown) {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual).toStrictEqual(expected);
}

/** Rewrite a stored event as an older build might have left it: without `complete`. */
function dropComplete(store: Store, seq: number) {
  store.atomic((db) =>
    db
      .prepare("UPDATE events SET payload = json_remove(payload, '$.item.complete') WHERE seq = ?")
      .run(seq),
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
  store.atomic((db) =>
    db.prepare("UPDATE events SET payload = ? WHERE seq = ?").run(original, seq),
  );
  if (event?.payload.type !== "item.created") throw new Error("expected an item event");
  return !("complete" in event.payload.item);
}
function seqs(events: Event[]) {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) throw new Error("nothing appended");
  return { oldest: first.seq, newest: last.seq };
}

it("older rows read the same before, during and after the idle pass confirms them", () => {
  const { open, idle, finish } = setup();
  const writer = open("build A");
  const { thread, events } = history(writer);
  const written = reads(writer, thread);
  expectSame(written.events.slice(-events.length), events);

  const reader = open("build B");
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

it("an old row validation would change stays on the validating path after the pass", () => {
  const { open, finish } = setup();
  const writer = open("build A");
  const { thread, events } = history(writer, 20);
  const changed = events[5];
  if (!changed) throw new Error("nothing appended");
  dropComplete(writer, changed.seq);
  writer.atomic((db) =>
    db.prepare("UPDATE items SET item = json_remove(item, '$.complete') WHERE id = 'm7'").run(),
  );

  const reader = open("build B");
  const before = reads(reader, thread);
  finish();
  const after = reads(reader, thread);
  expectSame(after, before);
  const event = after.events.find((candidate) => candidate.seq === changed.seq);
  expect(event?.payload).toMatchObject({ item: { id: "m5", complete: true } });
  expect(after.items).toContainEqual(expect.objectContaining({ id: "m7", complete: true }));
  const neighbour = events[6];
  if (!neighbour) throw new Error("nothing appended");
  expect(readAsStored(reader, neighbour.seq)).toBe(true);
});

it("an interrupted pass resumes where it stopped after a restart", () => {
  const { open, idle, finish } = setup();
  const writer = open("build A");
  const { thread, events } = history(writer);
  const written = reads(writer, thread);
  const { oldest, newest } = seqs(events);

  open("build B");
  idle();
  const reopened = open("build B");
  expect(readAsStored(reopened, newest)).toBe(true);
  expect(readAsStored(reopened, oldest)).toBe(false);

  finish();
  expect(readAsStored(reopened, oldest)).toBe(true);
  expectSame(reads(reopened, thread), written);
});

it("the pass does nothing while agents are writing", () => {
  const { open, idle } = setup();
  const writer = open("build A");
  const { thread, events } = history(writer, 10);
  const { newest } = seqs(events);

  const reader = open("build B");
  for (let index = 0; index < 5; index++) {
    reader.appendEvents(thread, [{ type: "item.created", item: message(`live${index}`) }]);
    idle();
  }
  expect(readAsStored(reader, newest)).toBe(false);

  idle();
  expect(readAsStored(reader, newest)).toBe(true);
});

it("rows confirmed before another build ran are checked again", () => {
  const { open, finish } = setup();
  const writer = open("build A");
  const { events } = history(writer, 10);
  const { oldest } = seqs(events);

  open("build B");
  finish();
  open("build A");
  const back = open("build B");
  expect(readAsStored(back, oldest)).toBe(false);
});

it("a row a build without the pass rewrote in between is decoded again", () => {
  const { open, finish } = setup();
  const writer = open("build A");
  const { events } = history(writer, 10);
  const { oldest } = seqs(events);

  const upgraded = open("build B");
  finish();
  // A build from before the pass records only its own start, and may rewrite old rows.
  upgraded.atomic((db) => trustedSequenceStart(db, "build without the pass"));
  dropComplete(upgraded, oldest);
  const back = open("build B");
  const event = back.readEvents({ afterSeq: oldest - 1, limit: 1 })[0];
  expect(event?.payload).toMatchObject({ item: { complete: true } });
});
