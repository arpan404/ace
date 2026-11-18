import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { threadRowsPerBatch } from "./stored-trust-pass.ts";
import { confirmedPerOpen } from "./thread-row-trust.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/**
 * A store whose thread row "shape" the test chooses, standing in for different builds, with
 * the idle trust pass ticked by hand.
 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-thread-row-trust-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store: Store | undefined;
  let tick: (() => void) | undefined;
  const open = (threadRowShape = "current") => {
    store?.close();
    tick = undefined;
    store = new Store(path, console.error, {
      threadRowShape,
      trustPass: {
        scheduler: (run) => {
          tick = run;
          return () => {
            tick = undefined;
          };
        },
      },
    });
    return store;
  };
  /** One idle tick of the trust pass; false once the pass has stopped. */
  const idle = () => {
    if (!tick) return false;
    tick();
    return true;
  };
  const close = () => {
    store?.close();
    store = undefined;
  };
  /** A connection of its own, as another program or an older build would have. */
  const raw = (run: (db: DatabaseSync) => void) => {
    close();
    const db = new DatabaseSync(path);
    try {
      run(db);
    } finally {
      db.close();
    }
  };
  /** A second connection beside the open store, for reading what it stored. */
  const peek = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  cleanup.push(close);
  return { open, close, raw, idle, peek };
}

function thread(store: Store) {
  return createDevThread(store, store.createWorkspace("/repo", "Repo", 1)).id;
}
/** A status value the schema would change on read: it drops the field it doesn't know. */
const addStray = "UPDATE threads SET status = json_set(status, '$.stray', 1) WHERE id = ?";
/** Stamp the row's current revision as confirmed, as a decoder that saw it differently might. */
const forgeStamp =
  "INSERT OR REPLACE INTO thread_row_trust SELECT thread_id, revision, 1 FROM sidebar_thread_revisions WHERE thread_id = ?";
/** Change every threads row outside the writer, so each takes a new, unconfirmed revision. */
const touchAll = "UPDATE threads SET title = title || '.'";
const confirmedSql =
  "SELECT COUNT(*) AS n FROM thread_row_trust AS trust JOIN sidebar_thread_revisions AS current ON current.thread_id = trust.thread_id AND current.revision = trust.revision";
const confirmedCount = (db: DatabaseSync) => Number(db.prepare(confirmedSql).get()?.n);
const confirmed = (db: DatabaseSync, id: ThreadId) =>
  db.prepare(`${confirmedSql} WHERE trust.thread_id = ?`).get(id)?.n === 1;
function threads(store: Store, count: number): ThreadId[] {
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  return Array.from({ length: count }, () => createDevThread(store, workspace).id);
}
const strayOf = (store: Store, id: ThreadId) =>
  Reflect.get(store.getThread(id)?.status ?? {}, "stray");

it("threads this build wrote read back after a restart exactly as they were", () => {
  const { open } = setup();
  const first = open();
  const id = thread(first);
  first.appendEvents(id, [{ type: "thread.updated", title: "Renamed" }], 2);
  first.appendEvents(id, [{ type: "thread.client.updated", changes: { pinned: true } }], 3);
  const before = JSON.stringify(first.getThread(id));

  const second = open();
  expect(JSON.stringify(second.getThread(id))).toBe(before);
  expect(JSON.stringify(second.listThreads().find((entry) => entry.id === id))).toBe(before);
});

it("rows this build's writer wrote stay confirmed across a restart without the idle pass", () => {
  const { open, raw } = setup();
  const store = open();
  const ids = threads(store, confirmedPerOpen + 6);
  for (const id of ids) store.appendEvents(id, [{ type: "thread.updated", title: "Renamed" }], 2);
  open();
  raw((db) => expect(confirmedCount(db)).toBe(ids.length));
});

it("open checks only the most recently changed rows and leaves the rest to the idle pass", () => {
  const { open, raw, idle, peek } = setup();
  const total = confirmedPerOpen + 2 * threadRowsPerBatch + 10;
  threads(open(), total);
  // Changed outside the writer, so no row is confirmed at its new revision.
  raw((db) => db.exec(touchAll));
  open();
  let previous = peek(confirmedCount);
  expect(previous).toBe(confirmedPerOpen);
  // Each idle batch checks a bounded number of rows; together they reach every one.
  let ticks = 0;
  while (previous < total) {
    expect(idle()).toBe(true);
    ticks++;
    const now = peek(confirmedCount);
    expect(now - previous).toBeLessThanOrEqual(threadRowsPerBatch);
    previous = now;
    expect(ticks).toBeLessThan(100);
  }
  expect(ticks).toBeGreaterThan(1);
});

it("a row the idle pass has not reached yet is validated on read", () => {
  const { open, raw, peek } = setup();
  const store = open();
  const [oldest] = threads(store, confirmedPerOpen + 4);
  if (!oldest) throw new Error("no thread");
  // The stray row is the oldest change; every other row changes after it.
  raw((db) => {
    db.prepare(addStray).run(oldest);
    db.prepare("UPDATE threads SET title = title || '.' WHERE id != ?").run(oldest);
  });
  const reopened = open();
  expect(peek((db) => confirmed(db, oldest))).toBe(false);
  expect(strayOf(reopened, oldest)).toBeUndefined();
});

it("the idle pass resumes after a restart where the last one stopped", () => {
  const { open, raw, idle, peek } = setup();
  const total = confirmedPerOpen + 3 * threadRowsPerBatch;
  threads(open(), total);
  raw((db) => db.exec(touchAll));
  /** Ticks until every row is confirmed. */
  const ticksToConfirmAll = () => {
    let ticks = 0;
    while (peek(confirmedCount) < total) {
      expect(idle()).toBe(true);
      ticks++;
    }
    return ticks;
  };
  open();
  idle();
  idle();
  // A fresh walk from the start would need as many ticks again as an uninterrupted one.
  open();
  const afterRestart = ticksToConfirmAll();

  raw((db) => db.exec(touchAll));
  open();
  const uninterrupted = ticksToConfirmAll();
  expect(afterRestart).toBe(uninterrupted - 2);
});

it("stamps of deleted threads are dropped, by the delete itself or by the idle pass", () => {
  const { open, close, raw, idle } = setup();
  const [kept, deleted] = threads(open(), 2);
  close();
  // A home from a build before the delete trigger, with a stamp left behind for a thread it
  // removed.
  raw((db) =>
    db.exec(`
      DROP TABLE thread_row_trust_progress;
      DROP TRIGGER thread_row_trust_owner_delete;
      DROP TRIGGER thread_row_trust_owner_rekey;
      INSERT INTO thread_row_trust VALUES ('gone', 1, 1);
    `),
  );
  open();
  for (let guard = 0; idle() && guard < 1000; guard++);
  close();
  raw((db) => {
    db.prepare("DELETE FROM threads WHERE id = ?").run(deleted);
    const stamped = db
      .prepare("SELECT thread_id FROM thread_row_trust ORDER BY thread_id")
      .all()
      .map((row) => row.thread_id);
    expect(stamped).toEqual([kept]);
  });
});

it("a row changed by direct SQL is validated again on the next read", () => {
  const { open } = setup();
  const store = open();
  const id = thread(store);
  store.atomic((db) => db.prepare(addStray).run(id));
  expect(strayOf(store, id)).toBeUndefined();
});

it("a row the schema would change is not confirmed at open, so it stays validated", () => {
  const { open, raw } = setup();
  const id = thread(open());
  raw((db) => db.prepare(addStray).run(id));
  expect(strayOf(open(), id)).toBeUndefined();
  // And on the open after, from the recorded check rather than a fresh one.
  expect(strayOf(open(), id)).toBeUndefined();
});

it("the writer does not confirm a row whose other columns it left unconfirmed", () => {
  const { open } = setup();
  const store = open();
  const id = thread(store);
  store.atomic((db) => db.prepare(addStray).run(id));
  store.appendEvents(id, [{ type: "thread.updated", title: "Renamed" }], 2);
  const listed = store.listThreads().find((entry) => entry.id === id);
  expect(listed?.title).toBe("Renamed");
  expect(Reflect.get(listed?.status ?? {}, "stray")).toBeUndefined();
});

it("a confirmed row is read as stored", () => {
  const { open, raw } = setup();
  const id = thread(open());
  raw((db) => {
    db.prepare(addStray).run(id);
    db.prepare(forgeStamp).run(id);
  });
  expect(strayOf(open(), id)).toBe(1);
});

it("a different build's stamps are dropped, so its confirmed rows are validated again", () => {
  const { open, raw } = setup();
  const id = thread(open("build A"));
  raw((db) => {
    db.prepare(addStray).run(id);
    db.prepare(forgeStamp).run(id);
  });
  expect(strayOf(open("build B"), id)).toBeUndefined();
});
