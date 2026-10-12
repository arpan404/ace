import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Store } from "../store.ts";
import { storageFixture } from "./test-support.ts";

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
const crash = (root: string, mode: "compact" | "compact-full") =>
  promisify(execFile)(process.execPath, [join(import.meta.dirname, "crash-worker.ts"), root, mode]);

test("compacting after purging threads shrinks the database file and leaves no reusable pages", async () => {
  const f = await open();
  await purge(f);
  const before = await f.storage.usage();
  expect(before.reclaimableDatabaseBytes).toBeGreaterThan(2 * 1024 * 1024);
  const compaction = await f.storage.compact("owner", {});
  expect(compaction).toMatchObject({ state: "complete", fullRequired: false, checkpointed: true });
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
  const compaction = await f.storage.compact("owner", {});
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

test("maintenance waits for an in-flight history publication and holds a new one out", async () => {
  const root = await directory();
  const store = new Store(join(root, "events.sqlite"));
  try {
    store.setHistoryWriting(true);
    let ran = false;
    const maintenance = store.maintenance(async () => {
      ran = true;
      expect(() => store.setHistoryWriting(true)).toThrow("Store is busy");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toBe(false);
    store.setHistoryWriting(false);
    await maintenance;
    expect(ran).toBe(true);
  } finally {
    await store.close();
  }
});

test("a kill mid-compaction leaves an intact database whose journal resumes to completion", async () => {
  const root = await directory();
  const f = await storageFixture(root);
  await purge(f);
  const before = await f.storage.usage();
  await f.close();
  await expect(crash(root, "compact")).rejects.toMatchObject({ signal: "SIGKILL" });
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

test("a killed full rebuild never restarts on its own and can be abandoned", async () => {
  const root = await directory();
  const f = await storageFixture(root);
  await purge(f);
  await f.close();
  await expect(crash(root, "compact-full")).rejects.toMatchObject({ signal: "SIGKILL" });
  expect(integrity(join(root, "events.sqlite"))).toBe("ok");
  const restarted = await open(root);
  await restarted.storage.resume();
  const waiting = await restarted.storage.compact("owner", {});
  expect(waiting).toMatchObject({ mode: "full", state: "interrupted" });
  expect(waiting.reclaimableDatabaseBytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(await restarted.storage.abandonCompaction(waiting.id)).toMatchObject({
    state: "abandoned",
  });
  expect((await restarted.storage.compact("owner", {})).state).toBe("complete");
});

test("a full rebuild requires confirmation", async () => {
  const f = await open();
  await expect(f.storage.compact("owner", { mode: "full" })).rejects.toThrow(
    "storage_confirmation_required",
  );
  const result = await f.storage.handle(
    "owner",
    { type: "storage.request", requestId: "r", operation: { op: "cleanup.compact", mode: "full" } },
    () => true,
  );
  expect(result.result).toMatchObject({ kind: "error", code: "invalid_request" });
});
