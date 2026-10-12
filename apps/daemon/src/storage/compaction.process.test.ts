import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { Store } from "../store.ts";
import { storageFixture } from "./test-support.ts";

// Each test writes and compacts several megabytes of real SQLite.
vi.setConfig({ testTimeout: 30_000 });
const fixtures: Awaited<ReturnType<typeof storageFixture>>[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-compaction-")));
  roots.push(root);
  return root;
}
async function open(...args: Parameters<typeof storageFixture>) {
  const fixture = await storageFixture(...args);
  fixtures.push(fixture);
  return fixture;
}
async function purge(f: Awaited<ReturnType<typeof storageFixture>>) {
  f.transcripts(24);
  const plan = await f.storage.plan("owner", {
    op: "cleanup.plan",
    kinds: ["threads"],
    forceItems: [],
  });
  expect(plan.items.filter((item) => item.disposition === "remove")).toHaveLength(24);
  expect((await f.storage.apply("owner", plan.id, plan.revision)).state).toBe("complete");
}
function integrity(path: string): string {
  // Opening recovers the WAL the killed process left, as a restarted daemon would.
  const db = new DatabaseSync(path);
  try {
    return String(db.prepare("PRAGMA integrity_check").get()?.integrity_check);
  } finally {
    db.close();
  }
}
const crash = (root: string) =>
  promisify(execFile)(process.execPath, [
    join(import.meta.dirname, "crash-worker.ts"),
    root,
    "compact",
  ]);

test("compacting after purging threads shrinks the database file and leaves no reusable pages", async () => {
  const f = await open();
  await purge(f);
  const before = await f.storage.usage();
  expect(before.reclaimableDatabaseBytes).toBeGreaterThan(2 * 1024 * 1024);
  const compaction = await f.storage.compact("owner");
  expect(compaction).toMatchObject({
    state: "complete",
    incrementalUnavailable: false,
    checkpointed: true,
  });
  const after = await f.storage.usage();
  expect(after.databaseBytes).toBeLessThan(before.databaseBytes - 2 * 1024 * 1024);
  expect(after.reclaimableDatabaseBytes).toBeLessThan(64 * 1024);
});

test("writes issued during compaction wait for it, then all commit", async () => {
  const writes: Promise<string>[] = [];
  let f: Awaited<ReturnType<typeof storageFixture>> | undefined;
  f = await open(undefined, undefined, {
    limits: { chunkPages: 16 },
    afterCompactionStep: async () => {
      const store = f?.store;
      if (!store || writes.length) return;
      for (let i = 0; i < 4; i++)
        writes.push(
          store.write((db) => {
            db.prepare("INSERT INTO compaction_probe VALUES (?)").run(i);
            // The commit observes the journal the compaction left behind.
            return String(db.prepare("SELECT state FROM storage_compactions LIMIT 1").get()?.state);
          }),
        );
      writes.push(
        store.write(() => {
          store.appendEvents(live.id, [{ type: "thread.updated", title: "renamed" }]);
          return String(
            store.statement("SELECT state FROM storage_compactions LIMIT 1").get()?.state,
          );
        }),
      );
    },
  });
  f.store.atomic((db) => db.exec("CREATE TABLE compaction_probe(n INTEGER)"));
  await purge(f);
  const live = f.thread("live");
  const compaction = await f.storage.compact("owner");
  expect(compaction.state).toBe("complete");
  expect(writes).toHaveLength(5);
  expect(await Promise.all(writes)).toEqual(Array(5).fill("complete"));
  expect(f.store.statement("SELECT COUNT(*) AS n FROM compaction_probe").get()?.n).toBe(4);
  expect(f.store.getThread(live.id)?.title).toBe("renamed");
});

test("a writer held by maintenance fails as busy after its bounded wait instead of hanging", async () => {
  const root = await directory();
  const store = new Store(join(root, "events.sqlite"), undefined, { writeGate: { holdMs: 20 } });
  try {
    const release = Promise.withResolvers<void>();
    const maintenance = store.maintenance(() => release.promise);
    await expect(store.write(() => 1)).rejects.toThrow("Store is busy");
    release.resolve();
    await maintenance;
    expect(await store.write(() => 2)).toBe(2);
  } finally {
    await store.close();
  }
});

test("maintenance waits for an in-flight history publication, and a new one queues behind it", async () => {
  const root = await directory();
  const store = new Store(join(root, "events.sqlite"));
  try {
    store.setHistoryWriting(true);
    let ran = false;
    let queued: Promise<void> | undefined;
    let publishing = false;
    const maintenance = store.maintenance(async () => {
      ran = true;
      queued = store.startHistoryWriting().then(() => {
        publishing = store.isHistoryWriting();
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.isHistoryWriting()).toBe(false);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(false);
    store.setHistoryWriting(false);
    await maintenance;
    await queued;
    expect(ran).toBe(true);
    expect(publishing).toBe(true);
  } finally {
    store.setHistoryWriting(false);
    await store.close();
  }
});

test("a kill mid-compaction leaves an intact database whose journal resumes to completion", async () => {
  const root = await directory();
  const f = await storageFixture(root);
  await purge(f);
  const before = await f.storage.usage();
  await f.close();
  await expect(crash(root)).rejects.toMatchObject({ signal: "SIGKILL" });
  expect(integrity(join(root, "events.sqlite"))).toBe("ok");
  const restarted = await open(root);
  expect(restarted.store.statement("SELECT state FROM storage_compactions").get()?.state).toBe(
    "running",
  );
  await restarted.storage.resume();
  const after = await restarted.storage.usage();
  expect(after.reclaimableDatabaseBytes).toBeLessThan(64 * 1024);
  expect(after.databaseBytes).toBeLessThan(before.databaseBytes - 2 * 1024 * 1024);
  expect(restarted.store.statement("SELECT state FROM storage_compactions").get()?.state).toBe(
    "complete",
  );
});

test("a stopped compaction is not resumed, and the next request starts a new one", async () => {
  const f = await open(undefined, undefined, { limits: { chunkPages: 8, maxChunks: 1 } });
  await purge(f);
  const pending = await f.storage.compact("owner");
  expect(pending.state).toBe("pending");
  expect(await f.storage.abandonCompaction(pending.id)).toMatchObject({ state: "abandoned" });
  const reclaimable = (await f.storage.usage()).reclaimableDatabaseBytes;
  await f.storage.resume();
  expect((await f.storage.usage()).reclaimableDatabaseBytes).toBe(reclaimable);
  const next = await f.storage.compact("owner");
  expect(next.id).not.toBe(pending.id);
  expect(next.reclaimableDatabaseBytes).toBeLessThan(reclaimable);
});

/** Rows of every rowid table without an INTEGER PRIMARY KEY alias, keyed by rowid. */
function implicitRowids(db: DatabaseSync) {
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
    )
    .all()
    .filter((row) => !/WITHOUT\s+ROWID/i.test(String(row.sql)))
    .map((row) => String(row.name))
    .filter((name) => {
      const keys = db
        .prepare(`SELECT type FROM pragma_table_info(?) WHERE pk>0`)
        .all(name)
        .map((row) => String(row.type).toUpperCase());
      return !(keys.length === 1 && keys[0] === "INTEGER");
    });
  return Object.fromEntries(
    tables.map((name) => [
      name,
      JSON.stringify(
        db.prepare(`SELECT rowid AS _rowid, * FROM "${name}" ORDER BY rowid`).all(),
        (_key, value: unknown) =>
          value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value,
      ),
    ]),
  );
}

test("a file created without incremental vacuum is reported and left untouched, rowids included", async () => {
  const root = await directory();
  const legacy = new DatabaseSync(join(root, "events.sqlite"));
  legacy.exec("PRAGMA auto_vacuum=NONE; PRAGMA journal_mode=WAL;");
  legacy.close();
  const f = await open(root);
  let connection: DatabaseSync | undefined;
  f.store.atomic((db) => {
    connection = db;
    // Rowids referenced elsewhere, with gaps that a rebuild would close by renumbering.
    db.exec("CREATE TABLE rowid_probe(owner TEXT NOT NULL, frame TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO rowid_probe VALUES (?,?)");
    for (let i = 0; i < 500; i++) insert.run(`owner-${i % 7}`, `frame-${i}`);
    db.exec("DELETE FROM rowid_probe WHERE rowid % 3 = 0");
  });
  if (!connection) throw new Error("Missing connection");
  await purge(f);
  const usage = await f.storage.usage();
  const { storage_compactions: _before, ...before } = implicitRowids(connection);
  const compaction = await f.storage.compact("owner");
  expect(compaction).toMatchObject({ state: "complete", incrementalUnavailable: true });
  expect(compaction.reclaimableDatabaseBytes).toBe(usage.reclaimableDatabaseBytes);
  expect(f.store.statement("PRAGMA auto_vacuum").get()?.auto_vacuum).toBe(0);
  const { storage_compactions: _after, ...after } = implicitRowids(connection);
  expect(before.rowid_probe).toBeDefined();
  expect(after).toEqual(before);
  expect(integrity(join(root, "events.sqlite"))).toBe("ok");
});
