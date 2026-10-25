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
  const dir = mkdtempSync(join(tmpdir(), "ace-revision-triggers-"));
  const path = join(dir, "events.sqlite");
  const db = new DatabaseSync(path);
  const store = new Store(path, () => {}, { database: db });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  const workspaceId = store.createWorkspace(dir, "Project");
  const id = ThreadId.parse("revised-thread");
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
        details: { mode: "local" },
      }),
    },
  ]);
  return { db, store, id, workspaceId };
}

// Each statement changes the row through a conflict rule of its own; SQLite applies an
// outer statement's rule to the statements its triggers run.
const threadWrites = {
  "UPDATE OR IGNORE": "UPDATE OR IGNORE threads SET title = 'Changed' WHERE id = :id",
  "UPDATE OR REPLACE": "UPDATE OR REPLACE threads SET title = 'Changed' WHERE id = :id",
  "UPDATE OR ROLLBACK": "UPDATE OR ROLLBACK threads SET title = 'Changed' WHERE id = :id",
  upsert:
    "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) VALUES (:id, :workspace, 'Changed', 'codex', '{\"state\":\"done\"}', 1, 1) ON CONFLICT(id) DO UPDATE SET title = excluded.title",
};
const coldWrites = {
  upsert:
    'INSERT INTO thread_cold (thread_id, details) VALUES (:id, \'{"mode":"worktree"}\') ON CONFLICT(thread_id) DO UPDATE SET details = excluded.details',
  "UPDATE OR IGNORE":
    'UPDATE OR IGNORE thread_cold SET details = \'{"mode":"worktree"}\' WHERE thread_id = :id',
  "INSERT OR REPLACE":
    'INSERT OR REPLACE INTO thread_cold (thread_id, details) VALUES (:id, \'{"mode":"worktree"}\')',
};

test.each(Object.entries(threadWrites))(
  "a thread row changed by %s reads back changed, from the cache and the sidebar",
  (_name, sql) => {
    const { db, store, id, workspaceId } = open();
    // Warm the cache and the live sidebar index, so a missed revision would show stale.
    expect(store.getThread(id)?.title).toBe("First");
    const entries = new Map(store.sidebarPage({ limit: 10 }).threads.map((t) => [t.id, t]));
    db.prepare(sql).run(sql.includes(":workspace") ? { id, workspace: workspaceId } : { id });
    expect(store.getThread(id)?.title).toBe("Changed");
    const live = store.sidebarPage({ limit: 10 }, undefined, { entries, changed: new Set() });
    expect(live.threads.find((thread) => thread.id === id)?.title).toBe("Changed");
  },
);

test.each(Object.entries(coldWrites))(
  "a thread's cold row changed by %s reads back changed",
  (_name, sql) => {
    const { db, store, id } = open();
    expect(store.getThread(id)?.details).toEqual({ mode: "local" });
    db.prepare(sql).run({ id });
    expect(store.getThread(id)?.details).toEqual({ mode: "worktree" });
    expect(store.readThread(id)?.details).toEqual({ mode: "worktree" });
  },
);

test("a thread inserted by INSERT OR IGNORE is found, and one it ignores stays as it was", () => {
  const { db, store, id, workspaceId } = open();
  expect(store.getThread(id)?.title).toBe("First");
  const insert = db.prepare(
    "INSERT OR IGNORE INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) VALUES (?, ?, ?, 'codex', '{\"state\":\"done\"}', 1, 1)",
  );
  insert.run(id, workspaceId, "Ignored");
  expect(store.getThread(id)?.title).toBe("First");
  const other = ThreadId.parse("inserted-thread");
  insert.run(other, workspaceId, "Inserted");
  expect(store.getThread(other)?.title).toBe("Inserted");
  expect(store.sidebarPage({ limit: 10 }).threads.map((thread) => thread.id)).toContain(other);
});

test("a database with the old revision triggers gets the safe ones on its next start", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-revision-upgrade-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "events.sqlite");
  const first = new Store(path);
  const workspaceId = first.createWorkspace(dir, "Project");
  const id = ThreadId.parse("upgraded-thread");
  first.appendEvents(id, [
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
  first.close();
  // The bodies an earlier build installed.
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TRIGGER sidebar_thread_update;
    CREATE TRIGGER sidebar_thread_update AFTER UPDATE ON threads BEGIN
      INSERT OR REPLACE INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
    END;
  `);
  old.close();
  const db = new DatabaseSync(path);
  const store = new Store(path, () => {}, { database: db });
  cleanups.push(() => store.close());
  expect(store.getThread(id)?.title).toBe("First");
  db.prepare("UPDATE OR IGNORE threads SET title = 'Changed' WHERE id = ?").run(id);
  expect(store.getThread(id)?.title).toBe("Changed");
});
