import { afterEach, expect, test } from "vitest";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openHistory, type HistoryOptions } from "./index.ts";
import { cwd, environment, init, memorySink, text } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function say(db: DatabaseSync, id: string, role: string, words: string, at: number) {
  db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
    id,
    "s1",
    at,
    JSON.stringify({ role, time: { created: at } }),
  );
  db.prepare("INSERT INTO part VALUES(?,?,?)").run(
    `${id}-part`,
    id,
    JSON.stringify({ type: "text", text: words }),
  );
}
/** An OpenCode home whose writer stays open, so committed rows live in a non-empty WAL. */
async function liveOpenCode() {
  const env = await environment();
  const home = join(env.root, "opencode");
  await mkdir(home);
  const path = join(home, "opencode.db");
  const writer = new DatabaseSync(path);
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT);`);
  writer.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)").run("s1", cwd, "Live session", 1);
  say(writer, "m1", "user", "Plan the migration", 1);
  cleanup.push(async () => {
    if (writer.isOpen) writer.close();
    await env.close();
  });
  const options: HistoryOptions = {
    indexPath: join(env.root, "ace/index.sqlite"),
    instances: [{ id: "oc", provider: "opencode", homeDir: home }],
  };
  const stages = async () =>
    (await readdir(join(env.root, "ace"))).filter((name) => name.startsWith("sqlite-read-"));
  return { env, home, path, writer, options, stages };
}

async function importText(service: Awaited<ReturnType<typeof openHistory>>, thread: string) {
  const source = (await service.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing OpenCode session");
  const sink = memorySink();
  await service.importSession(init(source.id, thread), sink);
  return text(sink.items);
}

test("an unchanged live OpenCode database is not snapshotted again on the next scan", async () => {
  const f = await liveOpenCode();
  const log = join(f.env.root, "snapshots.log");
  await writeFile(log, "");
  const spawn = (url: URL, workerOptions: WorkerOptions) =>
    new Worker(url, {
      ...workerOptions,
      execArgv: ["--import", new URL("./snapshot-trace.ts", import.meta.url).href],
      env: { ...process.env, ACE_TEST_SNAPSHOT_LOG: log },
    });
  const service = await openHistory(f.options, spawn);
  cleanup.unshift(() => service.close());
  expect((await service.scan()).unsupported).toEqual([]);
  const first = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  expect(first).toHaveLength(1);
  expect((await service.scan()).unsupported).toEqual([]);
  expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toEqual(first);
  expect(await f.stages()).toEqual([]);
});

test("a crashed daemon's leftover snapshot directories are removed at startup", async () => {
  const f = await liveOpenCode();
  const ace = join(f.env.root, "ace");
  await mkdir(join(ace, "sqlite-read-Ab12Cd"), { recursive: true });
  await writeFile(join(ace, "sqlite-read-Ab12Cd/snapshot.sqlite"), "partial copy");
  await mkdir(join(ace, `sqlite-read-${process.pid}-Zz9Yy8`));
  const service = await openHistory(f.options);
  cleanup.unshift(() => service.close());
  expect(await f.stages()).toEqual([]);
});

test("a database over the snapshot cap is refused with a notice and nothing written", async () => {
  const f = await liveOpenCode();
  const service = await openHistory({ ...f.options, snapshot: { maxCopyBytes: 1 } });
  cleanup.unshift(() => service.close());
  const scan = await service.scan();
  expect(scan.unsupported).toEqual([
    { instanceId: "oc", reason: expect.stringContaining("above the 1 MB snapshot limit") },
  ]);
  expect(await f.stages()).toEqual([]);
  expect((await service.list({ type: "history.list", cwd })).sessions).toEqual([]);
  // Backoff keeps surfacing the refusal without attempting another snapshot.
  say(f.writer, "m2", "assistant", "Still refused", 2);
  expect((await service.scan()).unsupported).toEqual(scan.unsupported);
  expect(await f.stages()).toEqual([]);
});

test("new provider rows are imported from live and quiescent databases", async () => {
  const f = await liveOpenCode();
  const service = await openHistory(f.options);
  cleanup.unshift(() => service.close());
  await service.scan();
  expect(await importText(service, "first-import")).toContain("Plan the migration");

  say(f.writer, "m2", "assistant", "Migration planned", 2);
  await service.scan();
  expect(await importText(service, "second-import")).toContain("Migration planned");

  // Closing the last writer checkpoints and removes the WAL; reads then happen in place.
  f.writer.close();
  const later = new DatabaseSync(f.path);
  say(later, "m3", "user", "Ship it", 3);
  later.close();
  await service.scan();
  const shipped = await importText(service, "third-import");
  expect(shipped).toContain("Migration planned");
  expect(shipped).toContain("Ship it");
  expect(await f.stages()).toEqual([]);
});
