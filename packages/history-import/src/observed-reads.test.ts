import { afterEach, expect, test } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openHistory } from "./index.ts";
import { environment, claudeRecords, jsonl, cwd, nativeId, init } from "./test-support.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
test("warm cached scans perform no actual FileHandle transcript reads even across restarts", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "claude"),
    log = join(env.root, "reads.jsonl");
  await writeFile(log, "");
  await jsonl(join(home, "projects/p", nativeId + ".jsonl"), claudeRecords());
  const options = {
    indexPath: join(env.root, "ace/index.sqlite"),
    instances: [{ id: "account", provider: "claude" as const, homeDir: home }],
  };
  const spawn = (url: URL, workerOptions: import("node:worker_threads").WorkerOptions) =>
    new Worker(url, {
      ...workerOptions,
      execArgv: ["--import", new URL("./read-trace.ts", import.meta.url).href],
      env: { ...process.env, ACE_TEST_READ_LOG: log },
    });
  const service = await openHistory(options, spawn);
  cleanup.unshift(() => service.close());
  await service.scan();
  const cold = await readFile(log, "utf8");
  expect(cold).toContain(nativeId + ".jsonl");
  await service.scan();
  expect(await readFile(log, "utf8")).toBe(cold);
  await service.close();
  const restarted = await openHistory(options, spawn);
  cleanup.unshift(() => restarted.close());
  await restarted.scan();
  expect(await readFile(log, "utf8")).toBe(cold);
});
test("item pages refuse limits above 200 instead of silently increasing the page cap", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "claude");
  await jsonl(join(home, "projects/p", nativeId + ".jsonl"), claudeRecords());
  const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
  await service.scan();
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing source");
  await service.importSession(init(source.id));
  await expect(
    service.itemsPage({ threadId: init(source.id).threadId, limit: 201 }),
  ).rejects.toThrow();
});
test("a database changed while scanning cannot publish stale sampled metadata", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "oc");
  await mkdir(home);
  const db = new DatabaseSync(join(home, "opencode.db"));
  cleanup.unshift(async () => db.close());
  db.exec(
    "CREATE TABLE session(id TEXT,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,data TEXT)",
  );
  const insert = db.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)");
  for (let i = 0; i < 96; i++) insert.run("s" + i, cwd, "before", 1);
  const service = await env.start([{ id: "oc", provider: "opencode", homeDir: home }]);
  let changed = false;
  const scan = await service.scan(undefined, async () => {
    if (!changed) {
      db.exec("UPDATE session SET title='changed while scanning'");
      changed = true;
    }
  });
  expect(changed).toBe(true);
  expect(scan.unsupported).toMatchObject([
    { reason: expect.stringContaining("changed during scan") },
  ]);
  expect((await service.list({ type: "history.list", cwd })).sessions).toEqual([]);
  await service.scan();
  expect((await service.list({ type: "history.list", cwd })).sessions[0]?.title).toBe(
    "changed while scanning",
  );
});
