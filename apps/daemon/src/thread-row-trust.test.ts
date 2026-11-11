import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { confirmThreadRows } from "./thread-row-trust.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** A store whose thread row "shape" the test chooses, standing in for different builds. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-thread-row-trust-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store: Store | undefined;
  const open = (threadRowShape = "current") => {
    store?.close();
    store = new Store(path, console.error, { threadRowShape });
    return store;
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
  cleanup.push(close);
  return { open, close, raw };
}

function thread(store: Store) {
  return createDevThread(store, store.createWorkspace("/repo", "Repo", 1)).id;
}
/** A status value the schema would change on read: it drops the field it doesn't know. */
const addStray = "UPDATE threads SET status = json_set(status, '$.stray', 1) WHERE id = ?";
/** Stamp the row's current revision as confirmed, as a decoder that saw it differently might. */
const forgeStamp =
  "INSERT OR REPLACE INTO thread_row_trust SELECT thread_id, revision, 1 FROM sidebar_thread_revisions WHERE thread_id = ?";
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

it("rows this build's writer wrote need no confirming again at the next open", () => {
  const { open, raw } = setup();
  const store = open();
  const id = thread(store);
  store.appendEvents(id, [{ type: "thread.updated", title: "Renamed" }], 2);
  let unconfirmed = -1;
  raw((db) => {
    unconfirmed = confirmThreadRows(db);
  });
  expect(unconfirmed).toBe(0);
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
