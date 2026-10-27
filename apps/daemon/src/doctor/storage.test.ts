import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
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

it("a daemon lock left by a process that exited is reported with its pid and no repair", async () => {
  const { context, dataDir, feature } = await setup();
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  if (exited === undefined) throw new Error("no child pid");
  await writeFile(join(dataDir, "daemon-lock"), JSON.stringify({ pid: exited, id: "x" }));

  const stale = await run(feature, context, "storage.locks");
  expect(stale.status).toBe("warn");
  expect(stale.message).toContain(`pid ${exited}, which isn't running`);
  const healthy = {
    at: 0,
    checks: [{ id: "sqlite", status: "ok" as const, message: "", fix: "" }],
  };
  expect((await feature.repairs?.(healthy, context)) ?? []).toEqual([]);

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
