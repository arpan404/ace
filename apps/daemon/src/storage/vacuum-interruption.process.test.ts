import { spawn, type ChildProcess } from "node:child_process";
import { watch, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "vitest";
import { storageFixture } from "./test-support.ts";

test("killing the helper while VACUUM writes its WAL preserves SQLite integrity and committed data", async () => {
  let child: ChildProcess | undefined,
    interrupted = false;
  const f = await storageFixture(undefined, undefined, {
    spawn(url, input) {
      child = spawn(process.execPath, [fileURLToPath(url), JSON.stringify(input)], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      return child;
    },
  });
  const thread = f.thread("committed-before-vacuum");
  // Bounded real data makes WAL publication observable before the helper can complete.
  f.store.atomic((db) => {
    db.exec("CREATE TABLE vacuum_data(id INTEGER PRIMARY KEY,body BLOB NOT NULL)");
    const insert = db.prepare("INSERT INTO vacuum_data VALUES (?,zeroblob(262144))");
    for (let id = 0; id < 256; id++) insert.run(id);
  });
  const plan = await f.storage.plan("owner", {
    op: "cleanup.plan",
    kinds: ["logs"],
    forceItems: [],
  });
  f.store.statement("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const wal = join(f.root, "events.sqlite-wal");
  const watcher = watch(wal, () => {
    if (!child || interrupted || child.exitCode !== null || child.signalCode !== null) return;
    try {
      // The production helper has reached real SQLite page publication, not a test pause.
      if (statSync(wal).size >= 1024 * 1024) interrupted = child.kill("SIGKILL");
    } catch {
      /* A concurrent checkpoint can truncate/remove the WAL. */
    }
  });
  try {
    expect(await f.storage.apply("owner", plan.id, plan.revision, true)).toMatchObject({
      state: "complete",
      compaction: "deferred",
    });
    expect(interrupted).toBe(true);
    expect(f.store.statement("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(f.store.getThread(thread.id)?.title).toBe("committed-before-vacuum");
    expect(
      f.store
        .statement("SELECT COUNT(*) AS rows,SUM(length(body)) AS bytes FROM vacuum_data")
        .get(),
    ).toMatchObject({ rows: 256, bytes: 67108864 });
    expect(f.thread("after-interrupted-vacuum").title).toBe("after-interrupted-vacuum");
  } finally {
    watcher.close();
    child?.kill("SIGKILL");
    await f.close();
  }
}, 30000);
