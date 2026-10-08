/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { openHistory } from "./index.ts";
import { cwd, environment } from "./test-support.ts";

test.each(["append", "checkpoint"])(
  "a WAL %s during snapshot copying publishes a consistent inventory without writing provider files",
  async (change) => {
    const env = await environment();
    const home = join(env.root, "opencode");
    await mkdir(home);
    const path = join(home, "opencode.db");
    const db = new DatabaseSync(path);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT,directory TEXT,title TEXT,time_updated INTEGER,parent_id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,data TEXT)",
    );
    db.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)").run("session", cwd, "before", 1);
    db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
      "message",
      "session",
      1,
      JSON.stringify({ role: "user" }),
    );
    db.prepare("INSERT INTO part VALUES(?,?,?)").run(
      "part",
      "message",
      JSON.stringify({ type: "text", text: "Inspect the snapshot" }),
    );
    let committed = false;
    let after: Buffer | undefined;
    let shm: Buffer | undefined;
    const service = await openHistory(
      {
        indexPath: join(env.root, "ace/index.sqlite"),
        instances: [{ id: "oc", provider: "opencode", homeDir: home }],
      },
      (url, options) => {
        const worker = new Worker(url, {
          ...options,
          execArgv: ["--import", new URL("./snapshot-race-boundary.ts", import.meta.url).href],
        });
        worker.on("message", (value: unknown) => {
          if (!value || typeof value !== "object" || !("snapshotPause" in value)) return;
          if (change === "checkpoint") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          db.exec("UPDATE session SET title='after',time_updated=2");
          committed = true;
          void Promise.all([readFile(path + "-wal"), readFile(path + "-shm")]).then(
            ([wal, marks]) => {
              after = wal;
              shm = marks;
              worker.postMessage("snapshot-continue");
            },
          );
        });
        return worker;
      },
    );
    try {
      expect((await service.scan()).unsupported).toEqual([]);
      expect(committed).toBe(true);
      expect((await service.list({ type: "history.list", cwd })).sessions[0]?.title).toBe(
        change === "append" ? "before" : "after",
      );
      expect(await readFile(path + "-wal")).toEqual(after);
      expect(await readFile(path + "-shm")).toEqual(shm);
      expect((await service.scan()).unsupported).toEqual([]);
      expect((await service.list({ type: "history.list", cwd })).sessions[0]?.title).toBe("after");
    } finally {
      await service.close();
      db.close();
      await env.close();
    }
  },
);
