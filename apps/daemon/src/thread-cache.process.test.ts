import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Thread, ThreadId } from "@ace/protocol";
import { Store } from "./store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "ace-thread-cache-"));
  const path = join(dir, "events.sqlite");
  const db = new DatabaseSync(path);
  const store = new Store(path, () => {}, { database: db });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  const workspaceId = store.createWorkspace(dir, "Project");
  const id = ThreadId.parse("cached-thread");
  store.appendEvents(id, [
    {
      type: "thread.created",
      thread: Thread.parse({
        id,
        workspaceId,
        title: "First",
        provider: "codex",
        status: { state: "done" },
        createdAt: 1,
        updatedAt: 1,
      }),
    },
  ]);
  // Warm the cache, so every test below proves a write replaces a cached copy.
  expect(store.getThread(id)?.title).toBe("First");
  const setTitle = (title: string) =>
    db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, id);
  return { path, db, store, id, workspaceId, setTitle };
}

test("a thread read after an event write shows the write", () => {
  const { store, id } = open();
  store.appendEvents(id, [{ type: "thread.updated", title: "Renamed" }]);
  expect(store.getThread(id)?.title).toBe("Renamed");
  expect(store.readThread(id)?.title).toBe("Renamed");
});

test("a direct SQL write through the store's transaction is seen by the next read", () => {
  const { store, id, setTitle } = open();
  store.atomic(() => setTitle("Direct"));
  expect(store.getThread(id)?.title).toBe("Direct");
});

test("a write by another connection to the same file is seen by the next read", () => {
  const { path, store, id } = open();
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout=5000");
  other.prepare("UPDATE threads SET title = 'Elsewhere' WHERE id = ?").run(id);
  other.close();
  expect(store.getThread(id)?.title).toBe("Elsewhere");
});

test("a rolled-back store transaction leaves no trace, even when its revision is reused", () => {
  const { store, id, setTitle } = open();
  expect(() =>
    store.atomic(() => {
      setTitle("Rolled back");
      // Read inside the transaction: the uncommitted row is visible here, and only here.
      expect(store.getThread(id)?.title).toBe("Rolled back");
      throw new Error("abort");
    }),
  ).toThrow("abort");
  expect(store.getThread(id)?.title).toBe("First");
  // The rollback also rolled back the revision counter, so this commit reuses the
  // revision the aborted write had. The read must still show this commit's row.
  store.atomic(() => setTitle("Committed"));
  expect(store.getThread(id)?.title).toBe("Committed");
});

test("a rolled-back nested savepoint and a raw rollback on the connection leave no trace", () => {
  const { db, store, id, setTitle } = open();
  store.atomic(() => {
    expect(() =>
      store.atomic(() => {
        setTitle("Nested");
        expect(store.readThread(id)?.title).toBe("Nested");
        throw new Error("inner");
      }),
    ).toThrow("inner");
    expect(store.getThread(id)?.title).toBe("First");
  });
  expect(store.getThread(id)?.title).toBe("First");

  // Other modules share the connection and run their own BEGIN/ROLLBACK.
  db.exec("BEGIN IMMEDIATE");
  setTitle("Raw");
  expect(store.getThread(id)?.title).toBe("Raw");
  db.exec("ROLLBACK");
  expect(store.getThread(id)?.title).toBe("First");
  setTitle("After raw");
  expect(store.getThread(id)?.title).toBe("After raw");
});

test("inside one transaction, a write after a rolled-back savepoint reads as itself", () => {
  const { store, id, setTitle } = open();
  store.atomic(() => {
    setTitle("Before");
    expect(store.getThread(id)?.title).toBe("Before");
    expect(() =>
      store.atomic(() => {
        setTitle("Inner");
        expect(store.getThread(id)?.title).toBe("Inner");
        throw new Error("inner");
      }),
    ).toThrow("inner");
    // The savepoint rollback handed the inner write's revision back; this write reuses it.
    setTitle("Outer");
    expect(store.readThread(id)?.title).toBe("Outer");
  });
  expect(store.getThread(id)?.title).toBe("Outer");
  setTitle("Later");
  expect(store.getThread(id)?.title).toBe("Later");
});

test("a deleted thread is gone, and one recreated under the same id reads as new", () => {
  const { db, store, id, workspaceId } = open();
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  expect(store.getThread(id)).toBeUndefined();
  store.appendEvents(id, [
    {
      type: "thread.created",
      thread: Thread.parse({
        id,
        workspaceId,
        title: "Again",
        provider: "codex",
        status: { state: "new" },
        createdAt: 2,
        updatedAt: 2,
      }),
    },
  ]);
  expect(store.getThread(id)?.title).toBe("Again");
});

test("a thread whose id changes is gone under the old id and found under the new one", () => {
  const { db, store, id } = open();
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("UPDATE threads SET id = 'moved-thread' WHERE id = ?").run(id);
  db.exec("PRAGMA foreign_keys=ON");
  expect(store.getThread(id)).toBeUndefined();
  expect(store.getThread(ThreadId.parse("moved-thread"))?.title).toBe("First");
});

test("changing a returned thread never changes what the next reader sees", () => {
  const { store, id } = open();
  const mine = store.getThread(id);
  if (!mine) throw new Error("Missing thread");
  mine.title = "Scribbled";
  mine.status = { state: "working", agents: 1 };
  expect(store.getThread(id)?.title).toBe("First");
  const shared = store.readThread(id);
  expect(() => {
    // @ts-expect-error The shared copy is read-only, and enforced at runtime too.
    shared.status.state = "failed";
  }).toThrow(TypeError);
  expect(store.getThread(id)?.status.state).toBe("done");
});
