import { setImmediate, setTimeout } from "node:timers/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import {
  storeFixture,
  cleanups,
  start,
  end,
  tool,
  turns,
  catchUp,
} from "./long-thread-test-support.ts";

async function backlog() {
  const f = storeFixture();
  start(f.store, f.thread, "old", 20);
  for (let index = 0; index < 260; index++) {
    f.store.appendEvents(
      f.thread.id,
      [
        {
          type: "item.created",
          item: tool(
            `old-${index}`,
            "succeeded",
            { kind: "shell", command: "old command", exitCode: 0 },
            "old",
          ),
        },
      ],
      30,
    );
  }
  end(f.store, f.thread, "old", 40);
  await f.store.close();
  const path = join(f.home, "events.sqlite");
  const writer = new DatabaseSync(path);
  // Model an upgrade with canonical history intact and no derived turn index.
  for (const row of writer
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'long_%'")
    .all()) {
    const name = String(row.name);
    if (!/^long_[a-z_]+$/.test(name)) throw new Error("Invalid fixture table");
    writer.exec(`DROP TABLE "${name}"`);
  }
  const errors: unknown[] = [];
  const store = new Store(path, (error) => errors.push(error));
  cleanups.push(() => store.close());
  cleanups.push(() => writer.close());
  expect(turns(store, f.thread)).toMatchObject({ ready: false, indexedSeq: 0 });
  return { ...f, store, writer, errors };
}

test("long-thread backfill catches up after another writer outlasts the SQLite busy timeout", async () => {
  const f = await backlog();
  f.writer.exec("BEGIN IMMEDIATE");
  // The next scheduled backfill batch waits for the real five-second SQLite timeout.
  await setImmediate();
  f.writer.exec("COMMIT");
  start(f.store, f.thread, "new", 50);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "new-command",
          "succeeded",
          { kind: "shell", command: "new command", exitCode: 0 },
          "new",
        ),
      },
    ],
    60,
  );
  end(f.store, f.thread, "new", 70);
  await expect.poll(() => turns(f.store, f.thread).ready, { timeout: 2000 }).toBe(true);
  const page = turns(f.store, f.thread);
  expect(page.indexedSeq).toBe(f.store.headSeq());
  expect(page.turns.map((turn) => turn.ordinal)).toEqual([1, 2]);
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 })).toMatchObject({
    turnsCompleted: 2,
    digest: { commandsRun: 261 },
  });
  expect(f.errors).toEqual([]);
});

test("backfill waits for history publication and resumes without duplicate counters", async () => {
  const f = await backlog();
  f.store.setHistoryWriting(true);
  f.store.statement("PRAGMA busy_timeout=0").get();
  f.writer.exec("BEGIN IMMEDIATE");
  await setImmediate();
  expect(turns(f.store, f.thread)).toMatchObject({ ready: false, indexedSeq: 0 });
  f.writer.exec("COMMIT");
  f.store.setHistoryWriting(false);
  await expect.poll(() => turns(f.store, f.thread).ready).toBe(true);
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 })).toMatchObject({
    turnsCompleted: 1,
    digest: { commandsRun: 260 },
  });
  expect(f.errors).toEqual([]);
});

test("closing during contention cancels pending backfill recovery", async () => {
  const f = await backlog();
  f.store.statement("PRAGMA busy_timeout=0").get();
  f.writer.exec("BEGIN IMMEDIATE");
  await setImmediate();
  await f.store.close();
  f.writer.exec("COMMIT");
  await setTimeout(150);
  expect(f.errors).toEqual([]);
});

test("a permanent backfill decode failure remains observable", async () => {
  const f = await backlog();
  f.writer.prepare("UPDATE events SET payload='invalid JSON' WHERE seq=200").run();
  await expect.poll(() => f.errors.length).toBe(1);
  expect(turns(f.store, f.thread).ready).toBe(false);
  expect(f.errors[0]).toBeInstanceOf(SyntaxError);
});

test("closing cancels a backfill waiting on the history publication lease", async () => {
  const f = await backlog();
  f.store.setHistoryWriting(true);
  await setImmediate();
  await f.store.close();
  await setImmediate();
  expect(f.errors).toEqual([]);
});
