import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-sidebar-revisions-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const raw = (run: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(path);
    try {
      run(db);
    } finally {
      db.close();
    }
  };
  const first = new Store(path, console.error);
  const workspace = first.createWorkspace("/repo", "Repo", 1);
  const ids = [createDevThread(first, workspace).id, createDevThread(first, workspace).id];
  first.close();
  /** Open, read the sidebar's thread ids, close. */
  const listed = () => {
    const store = new Store(path, console.error);
    try {
      return store
        .sidebarPage({ limit: 10 })
        .threads.map((thread) => thread.id)
        .toSorted();
    } finally {
      store.close();
    }
  };
  return { raw, ids, listed };
}

/** A thread row with no revision, as one written before the revision triggers existed. */
const dropRevision = (db: DatabaseSync, id: ThreadId) =>
  db.prepare("DELETE FROM sidebar_thread_revisions WHERE thread_id = ?").run(id);
const revisions = (db: DatabaseSync) =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM sidebar_thread_revisions").get()?.n);

it("a home from before the revision triggers gives every thread a revision on its first open", () => {
  const { raw, ids, listed } = setup();
  const [lost] = ids;
  if (!lost) throw new Error("no thread");
  raw((db) => {
    db.exec("DROP TABLE sidebar_revisions_complete");
    dropRevision(db, lost);
    // A revision left by a thread deleted while foreign keys were off and no trigger ran.
    db.exec(
      "PRAGMA foreign_keys=OFF; INSERT INTO sidebar_thread_revisions(thread_id) VALUES ('gone')",
    );
  });
  expect(listed()).toEqual(ids.toSorted());
  raw((db) => {
    expect(revisions(db)).toBe(ids.length);
    expect(
      db.prepare("SELECT 1 FROM sidebar_thread_revisions WHERE thread_id = 'gone'").get(),
    ).toBeUndefined();
  });
});

it("later opens don't read every thread to check their revisions", () => {
  const { raw, ids, listed } = setup();
  const [lost] = ids;
  if (!lost) throw new Error("no thread");
  // Only a full pass at open would put this row back; the triggers can't see it go.
  raw((db) => dropRevision(db, lost));
  listed();
  raw((db) => expect(revisions(db)).toBe(ids.length - 1));
});
