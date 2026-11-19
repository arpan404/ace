import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Store, createDevThread } from "@ace/daemon";
import { UPGRADE_FLOOR, createDatabaseAt, schemaVersion } from "./migrations.ts";

/**
 * Every schema this build upgrades from, built by the steps its release ran rather than by
 * rewinding a current database, so a step that adds a column twice, or open-time work that
 * needs a column a later step adds, fails here before it fails a real upgrade.
 */
const supported = Array.from(
  { length: schemaVersion - UPGRADE_FLOOR },
  (_, index) => UPGRADE_FLOOR + index,
);

/** The columns threads have had since the upgrade floor; later steps add the rest. */
const floorThreadColumns =
  "id, workspace_id, title, provider, status, created_at, updated_at, archived_at, root_agent_id, imported, acp, transitions, provider_metadata";

let home: string;
let fresh: { schema: SchemaObject[]; workspace: SQLOutputValue[]; thread: SQLOutputValue[] };

type SchemaObject = Record<"type" | "name" | "tbl_name" | "sql", SQLOutputValue | undefined>;

function schemaOf(path: string): SchemaObject[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all()
      .map(({ type, name, tbl_name, sql }) => ({ type, name, tbl_name, sql }));
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "ace-schema-upgrades-"));
  // A current database with one project and thread, whose rows each older layout is given.
  const path = join(home, "fresh.sqlite");
  const store = new Store(path);
  const thread = createDevThread(store, store.createWorkspace(home, "Existing project"));
  store.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const workspace = Object.values(
      db.prepare("SELECT id, path, name, created_at FROM workspaces").get() ?? {},
    );
    const row = Object.values(
      db.prepare(`SELECT ${floorThreadColumns} FROM threads WHERE id = ?`).get(thread.id) ?? {},
    );
    fresh = { schema: [], workspace, thread: row };
  } finally {
    db.close();
  }
  fresh.schema = schemaOf(path);
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

test.each(supported)(
  "a database at schema %s upgrades to the current schema with its threads, and reopens unchanged",
  (version) => {
    const path = join(home, `schema-${version}.sqlite`);
    const db = new DatabaseSync(path);
    try {
      createDatabaseAt(db, version);
      db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?)").run(...fresh.workspace);
      db.prepare(
        `INSERT INTO threads (${floorThreadColumns}) VALUES (${fresh.thread.map(() => "?").join(", ")})`,
      ).run(...fresh.thread);
    } finally {
      db.close();
    }
    const threadId = fresh.thread[0];
    for (let open = 0; open < 2; open++) {
      const store = new Store(path);
      try {
        expect(store.listThreads().map((thread) => thread.id)).toEqual([threadId]);
      } finally {
        store.close();
      }
      // The same layout a new database gets, so no step was skipped, repeated or reordered.
      expect(schemaOf(path)).toEqual(fresh.schema);
    }
  },
);
