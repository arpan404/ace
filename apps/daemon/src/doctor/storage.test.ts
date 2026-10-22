import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { DiagnosticReport } from "@ace/protocol";
import type { DoctorContext } from "./feature.ts";
import { createStorageFeature, type StorageOptions } from "./storage.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const signal = new AbortController().signal;
const MIB = 1024 ** 2;

async function setup(options: StorageOptions = {}) {
  const { context, dataDir, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  return { context, dataDir, feature: createStorageFeature(options) };
}

async function run(
  feature: ReturnType<typeof createStorageFeature>,
  context: DoctorContext,
  id: string,
) {
  const check = feature.checks(context).find((candidate) => candidate.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check.run(signal);
}

/** A database recording `version`, as the daemon's migrations leave it. */
function database(path: string, version: number) {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO schema_version VALUES (1, ?)").run(version);
  db.close();
}

/** The pre-upgrade copy the daemon writes beside a database before migrating it. */
function upgradeBackup(dataDir: string, version: number): string {
  const path = join(dataDir, `events.sqlite.schema-${version}.backup`);
  database(path, version);
  return path;
}

function report(sqlite: "ok" | "warn" | "fail"): DiagnosticReport {
  return { at: 0, checks: [{ id: "sqlite", status: sqlite, message: "", fix: "" }] };
}

it("usage names each database with its WAL, and logs against the saved cap", async () => {
  const { context, dataDir, feature } = await setup();
  await writeFile(join(dataDir, "events.sqlite"), Buffer.alloc(2 * MIB));
  await writeFile(join(dataDir, "events.sqlite-wal"), Buffer.alloc(4096));
  await writeFile(join(dataDir, "usage.sqlite"), Buffer.alloc(512 * 1024));
  await mkdir(join(dataDir, "logs"));
  await writeFile(join(dataDir, "logs", "ace.jsonl"), Buffer.alloc(MIB / 2));
  await mkdir(join(dataDir, "chromium"));
  await writeFile(join(dataDir, "chromium", "cache"), Buffer.alloc(3 * MIB));

  const quiet = await run(feature, context, "storage.usage");
  expect(quiet.status).toBe("ok");
  expect(quiet.message).toContain(
    "Databases 2.5 MB: events.sqlite 2.0 MB (WAL 4.0 KB), usage.sqlite 512.0 KB.",
  );
  expect(quiet.message).toContain("Logs 512.0 KB of a 1.0 GB cap.");
  expect(quiet.message).toContain("Other folders: chromium 3.0 MB.");

  await writeFile(
    join(dataDir, "settings.json"),
    JSON.stringify({ version: 2, settings: { "logs.maxBytes": MIB } }),
  );
  await writeFile(join(dataDir, "logs", "ace.jsonl.1"), Buffer.alloc(3 * MIB));
  const over = await run(feature, context, "storage.usage");
  expect(over.status).toBe("warn");
  expect(over.message).toContain("Logs use 3.5 MB, over their 1.0 MB cap");
});

it("a walk cut short by its entry limit reports worktrees as a lower bound", async () => {
  const { context, dataDir, feature } = await setup({ walk: { maxEntries: 5, maxMs: 60_000 } });
  const tree = join(dataDir, "worktrees", "a1");
  await mkdir(tree, { recursive: true });
  for (let index = 0; index < 20; index++)
    await writeFile(join(tree, `file-${index}`), Buffer.alloc(1024));

  const verdict = await run(feature, context, "storage.usage");
  expect(verdict.message).toMatch(/Worktrees: 1 folder, at least [\d.]+ KB\./);

  const roomy = await run(
    createStorageFeature({ walk: { maxEntries: 1000, maxMs: 60_000 } }),
    context,
    "storage.usage",
  );
  expect(roomy.message).toContain("Worktrees: 1 folder, 20.0 KB.");
});

it("an old upgrade backup is reported, offered unticked, and deleted alone when chosen", async () => {
  const { context, dataDir, feature } = await setup();
  database(join(dataDir, "events.sqlite"), 15);
  upgradeBackup(dataDir, 14);
  // The current schema's own copy could still be needed, and other files aren't backups.
  upgradeBackup(dataDir, 15);
  await writeFile(join(dataDir, "notes.backup"), "keep me");

  const verdict = await run(feature, context, "storage.backups");
  expect(verdict.status).toBe("warn");
  expect(verdict.message).toContain("events.sqlite.schema-14.backup");
  expect(verdict.message).toContain(
    "events.sqlite.schema-15.backup stays: events.sqlite is still on schema 15",
  );

  const healthy = report("ok");
  const [repair, ...others] = feature.repairs?.(healthy, context) ?? [];
  expect(others).toEqual([]);
  expect(repair).toMatchObject({ id: "storage.backups", recommended: false });
  expect(repair?.blocked).toBeUndefined();
  expect(repair?.title).toMatch(/^Delete old database backups \([\d.]+ KB\)$/);
  expect(repair?.detail).toContain("can't roll back");
  expect(repair?.detail).not.toContain("schema-15");

  const results = (await feature.apply?.("storage.backups", healthy, context)) ?? [];
  expect(results).toEqual([expect.objectContaining({ id: "storage.backups", status: "fixed" })]);
  expect((await readdir(dataDir)).toSorted()).toEqual([
    "events.sqlite",
    "events.sqlite.schema-15.backup",
    "notes.backup",
  ]);
});

it("backups stay while the database integrity check hasn't passed", async () => {
  const { context, dataDir, feature } = await setup();
  database(join(dataDir, "events.sqlite"), 15);
  upgradeBackup(dataDir, 14);

  for (const status of ["fail", "warn"] as const) {
    const [repair] = feature.repairs?.(report(status), context) ?? [];
    expect(repair?.blocked).toContain("integrity check");
    const results = (await feature.apply?.("storage.backups", report(status), context)) ?? [];
    expect(results[0]?.status).toBe("skipped");
  }
  expect(await readdir(dataDir)).toContain("events.sqlite.schema-14.backup");
});

it("a backup whose database didn't open is kept as possibly the only copy", async () => {
  const { context, dataDir, feature } = await setup();
  await writeFile(join(dataDir, "events.sqlite"), "not a database");
  upgradeBackup(dataDir, 14);

  expect(feature.repairs?.(report("ok"), context)).toEqual([]);
  const verdict = await run(feature, context, "storage.backups");
  expect(verdict.message).toContain("events.sqlite doesn't open, so this may be the only copy");
});

it("a daemon lock left by a process that exited is reported with its pid and no repair", async () => {
  const { context, dataDir, feature } = await setup();
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  if (exited === undefined) throw new Error("no child pid");
  await writeFile(join(dataDir, "daemon-lock"), JSON.stringify({ pid: exited, id: "x" }));

  const stale = await run(feature, context, "storage.locks");
  expect(stale.status).toBe("warn");
  expect(stale.message).toContain(`pid ${exited}, which isn't running`);
  expect(feature.repairs?.(report("ok"), context)).toEqual([]);

  await writeFile(join(dataDir, "daemon-lock"), JSON.stringify({ pid: process.pid, id: "y" }));
  expect((await run(feature, context, "storage.locks")).status).toBe("ok");
});

it("free space below the largest database warns, since upgrades and compaction need room", async () => {
  const { context, dataDir } = await setup();
  await writeFile(join(dataDir, "events.sqlite"), Buffer.alloc(2 * MIB));
  const tight = createStorageFeature({ freeBytes: async () => MIB });
  const verdict = await run(tight, context, "storage.space");
  expect(verdict.status).toBe("warn");
  expect(verdict.message).toContain(
    "1.0 MB free, less than the largest database (events.sqlite, 2.0 MB)",
  );

  const roomy = createStorageFeature({ freeBytes: async () => 10 * MIB });
  expect((await run(roomy, context, "storage.space")).status).toBe("ok");
});
