import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Thread, type ThreadListCursor } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { SidebarLive } from "./sidebar-live.ts";
import { sidebarPageStorage } from "./sidebar-page-storage.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-sidebar-columns-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const first = new Store(path, console.error);
  let store: Store | undefined = first;
  const close = () => {
    store?.close();
    store = undefined;
  };
  cleanup.push(close);
  const open = () => {
    close();
    store = new Store(path, console.error);
    return store;
  };
  const raw = () => {
    close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    cleanup.push(() => {
      if (db.isOpen) db.close();
    });
    return db;
  };
  return { store: first, open, raw };
}

/** Threads in three projects, created through the writer, with activity that often ties. */
function seed(store: Store, count: number) {
  const projects = [0, 1, 2].map((i) => store.createWorkspace(`/repo-${i}`, `Repo ${i}`, 1));
  for (let i = 0; i < count; i++) {
    const thread = Thread.parse({
      id: `t-${String(i).padStart(3, "0")}`,
      workspaceId: projects[i % 3],
      title: `Task ${i}`,
      provider: "codex",
      status: { state: "done" },
      createdAt: 1,
      updatedAt: 1000 + (i % 9),
      activityAt: 2000 + (i % 7),
      settledAt: 3000,
      hasSentMessage: true,
    });
    store.appendEvents(thread.id, [{ type: "thread.created", thread }], thread.updatedAt);
  }
  return projects;
}

/** Deterministic pseudo-random choices, so the corpus is varied and the same every run. */
function chooser(seedValue: number) {
  let state = seedValue;
  return <T>(options: readonly T[]): T => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return options[(state >>> 16) % options.length] as T;
  };
}

/**
 * Rewrite every fact the sidebar reads, by raw SQL as another program would: states, pins,
 * settling, queue attention, drafts, delegation, hosts, deletes, archives and activity ties.
 */
function vary(db: DatabaseSync, count: number, seedValue: number) {
  const pick = chooser(seedValue);
  const update = db.prepare(
    `UPDATE threads SET status = json(?), title = ?, archived_at = ?, updated_at = ?,
      client = json_set(COALESCE(client, '{}'), '$.pinned', json(?), '$.settledAt', json(?), '$.settledReason', json(?),
        '$.activityAt', json(?), '$.deletedAt', json(?), '$.host', json(?), '$.hasSentMessage', json(?)),
      provider_metadata = json_set(COALESCE(provider_metadata, '{}'), '$.queue', json(?)),
      transitions = json_set(COALESCE(transitions, '{}'), '$.delegatedFrom', json(?))
    WHERE id = ?`,
  );
  const queues = [
    "null",
    "null",
    "null",
    "null",
    '{"paused":true,"reason":"error"}',
    '{"paused":true,"reason":"limit"}',
    '{"paused":true,"reason":"manual","pendingCount":0}',
    '{"paused":true,"reason":"manual","pendingCount":2}',
    '{"paused":true,"reason":"error","resumeAt":5}',
    '{"paused":false,"reason":"error"}',
  ];
  for (let i = 0; i < count; i++)
    update.run(
      pick([
        '{"state":"done"}',
        '{"state":"done"}',
        '{"state":"done"}',
        '{"state":"failed"}',
        '{"state":"working","agents":1}',
        '{"state":"needs_you","interactions":1}',
        '{"state":"new"}',
      ]),
      pick(["Task", "New thread"]),
      pick([null, null, null, null, null, 4000, 4001, 4001]),
      pick([1000, 1001, 1002]),
      pick(["null", "null", "false", "true"]),
      pick(["3000", "3000", "3000", "null"]),
      pick(["null", '"manual"']),
      pick(["2000", "2001", "2001", "null", '"2001"']),
      pick(["null", "null", "null", "null", "9"]),
      pick(["null", "null", "null", "null", '"host"']),
      pick(["true", "true", "false", "null"]),
      pick(queues),
      pick(["null", "null", "null", '"paired"']),
      `t-${String(i).padStart(3, "0")}`,
    );
}

type Row = Record<string, SQLOutputValue>;
/** Just what a page needs to say where the next one starts. */
function entry(row: Row): Thread {
  const client = JSON.parse(String(row.client ?? "{}")) as { activityAt?: unknown };
  return {
    id: row.id,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(client.activityAt == null ? {} : { activityAt: client.activityAt }),
  } as unknown as Thread;
}

/** Every scope the sidebar reads: all projects and each one, live and archived. */
function scopes(projects: string[]) {
  return [undefined, ...projects, "no-such-project"].flatMap((project) =>
    [false, true].map((archived) => ({ project, archived })),
  );
}

/** Every page of every scope, walked to the end, with each window's total and counts. */
function allPages(db: DatabaseSync, projects: string[]) {
  const statement = (sql: string) => db.prepare(sql);
  return scopes(projects).map((scope) => {
    const pages = [];
    let before: ThreadListCursor | undefined;
    do {
      const page = sidebarPageStorage(statement, entry, { limit: 7, ...scope }, before);
      pages.push({ ids: page.threads.map((thread) => thread.id), ...page.window });
      before = page.window.before ?? undefined;
    } while (before);
    const live = new SidebarLive(statement);
    live.sync();
    return { scope, pages, live: live.index.window(scope, 7) };
  });
}

/** The same reads with the facts evaluated from the threads JSON, as before the table. */
function fromJson<T>(db: DatabaseSync, read: () => T): T {
  db.exec(
    "CREATE TEMP TABLE sidebar_thread_columns (thread_id TEXT PRIMARY KEY, revision INTEGER, readable INTEGER)",
  );
  db.exec("INSERT INTO temp.sidebar_thread_columns VALUES ('-', 0, 0)");
  try {
    return read();
  } finally {
    db.exec("DROP TABLE temp.sidebar_thread_columns");
  }
}

it("every tab, filter and project lists, orders and counts the same as from the threads JSON", () => {
  const { store, raw } = setup();
  const projects = seed(store, 90);
  for (const seedValue of [1, 7, 42]) {
    const db = raw();
    vary(db, 90, seedValue);
    const read = allPages(db, projects);
    expect(read).toEqual(fromJson(db, () => allPages(db, projects)));
    // The corpus exercises live, paged, archived and counted threads in more than one project.
    const all = read.find((each) => each.scope.project === undefined && !each.scope.archived);
    expect(all?.live.active.length).toBeGreaterThan(3);
    expect(all?.live.total).toBeGreaterThan(7);
    expect(all?.pages.at(0)?.counts.length).toBe(3);
    const archived = read.find((each) => each.scope.project === undefined && each.scope.archived);
    expect(archived?.live.total).toBeGreaterThan(3);
    db.close();
  }
});

it("a thread changed by raw SQL moves tab and count in the same transaction", () => {
  const { store, raw } = setup();
  const projects = seed(store, 12);
  const db = raw();
  const before = allPages(db, projects);
  db.exec("BEGIN");
  db.exec("UPDATE threads SET archived_at = 5000 WHERE id = 't-003'");
  db.exec(
    "UPDATE threads SET client = json_set(client, '$.pinned', json('true')) WHERE id = 't-004'",
  );
  db.exec("DELETE FROM threads WHERE id = 't-005'");
  db.exec("COMMIT");
  const after = allPages(db, projects);
  expect(after).toEqual(fromJson(db, () => allPages(db, projects)));
  const inbox = (read: typeof before) =>
    read.find((each) => each.scope.project === undefined && !each.scope.archived);
  expect(inbox(before)?.live.total).toBe(12);
  expect(inbox(after)?.live).toMatchObject({ active: ["t-004"], total: 9 });
  expect(inbox(after)?.live.page).not.toContain("t-003");
  const archive = after.find((each) => each.scope.project === undefined && each.scope.archived);
  expect(archive?.live.page).toEqual(["t-003"]);
});

it("threads changed while the table's triggers were gone are listed by their new facts after the next open", () => {
  const { store, raw, open } = setup();
  const projects = seed(store, 20);
  const db = raw();
  // Another build or program without these triggers changes rows behind the table's back.
  db.exec("DROP TRIGGER sidebar_columns_insert; DROP TRIGGER sidebar_columns_delete");
  db.exec("UPDATE threads SET archived_at = 5000 WHERE id IN ('t-001', 't-002')");
  db.exec(
    "UPDATE threads SET client = json_set(client, '$.pinned', json('true')) WHERE id = 't-003'",
  );
  db.exec(
    "UPDATE threads SET client = json_set(client, '$.activityAt', 9000), workspace_id = (SELECT workspace_id FROM threads WHERE id = 't-005') WHERE id = 't-004'",
  );
  db.exec('UPDATE threads SET status = \'{"state":"working","agents":1}\' WHERE id = \'t-006\'');
  db.exec("DELETE FROM threads WHERE id = 't-007'");
  db.close();
  open().close();
  const check = raw();
  const read = allPages(check, projects);
  expect(read).toEqual(fromJson(check, () => allPages(check, projects)));
  const inbox = read.find((each) => each.scope.project === undefined && !each.scope.archived);
  expect(inbox?.live).toMatchObject({ active: ["t-006", "t-003"], total: 15 });
  expect(inbox?.live.page[0]).toBe("t-004");
});

it("a thread whose JSON the sidebar can't read never blocks a write, and lists once it is fixed", () => {
  const { store, raw } = setup();
  const projects = seed(store, 6);
  const db = raw();
  db.exec("UPDATE threads SET client = '{not json' WHERE id = 't-001'");
  db.exec("UPDATE threads SET updated_at = 1500 WHERE id = 't-001'");
  db.exec(
    `UPDATE threads SET client = '{"settledAt":3000,"hasSentMessage":true,"activityAt":9000}' WHERE id = 't-001'`,
  );
  const read = allPages(db, projects);
  expect(read).toEqual(fromJson(db, () => allPages(db, projects)));
  expect(read[0]?.pages[0]?.ids[0]).toBe("t-001");
});
