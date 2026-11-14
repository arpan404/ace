import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-auto-rollback-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  // RAISE(ROLLBACK) ends the whole transaction inside SQLite, as SQLITE_FULL or an I/O error does.
  store.statement("CREATE TABLE doomed (x)").run();
  store
    .statement(
      "CREATE TRIGGER doomed_rollback BEFORE INSERT ON doomed BEGIN SELECT RAISE(ROLLBACK, 'disk full'); END",
    )
    .run();
  return { store, a: createDevThread(store, workspace), b: createDevThread(store, workspace) };
}

it("live rows lost to a rollback SQLite made itself are never reported committed", () => {
  const { store, a, b } = setup();
  const committed: string[] = [];
  expect(() =>
    store.atomic(() => {
      store.prepareLiveWrite(100);
      // A boundary event flushes at once, inside this transaction.
      store.bufferLiveWrite(a.id, [{ type: "thread.updated", title: "live" }], 1000, {
        persist() {},
        committed: () => committed.push(store.getThread(a.id)?.title ?? "missing"),
      });
      store.statement("INSERT INTO doomed VALUES (1)").run();
    }),
  ).toThrow("disk full");
  expect(store.getThread(a.id)?.title).not.toBe("live");
  // A later transaction must not settle the lost batch as committed.
  store.appendEvents(b.id, [{ type: "thread.updated", title: "other" }]);
  for (const title of committed) expect(title).toBe("live");
  // The batch is still pending and is written by the next flush.
  store.flushLiveWrites();
  expect(store.getThread(a.id)?.title).toBe("live");
  expect(committed).toEqual(["live"]);
});

it("the store's own error surfaces after SQLite rolled back by itself, and writes go on", () => {
  const { store, a } = setup();
  expect(() => store.atomic(() => store.statement("INSERT INTO doomed VALUES (1)").run())).toThrow(
    "disk full",
  );
  store.appendEvents(a.id, [{ type: "thread.updated", title: "after" }]);
  expect(store.getThread(a.id)?.title).toBe("after");
});
