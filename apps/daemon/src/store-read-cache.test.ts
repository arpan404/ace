import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { message } from "./payload-test-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-read-cache-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const store = new Store(path);
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const a = createDevThread(store, workspace);
  const b = createDevThread(store, workspace);
  const reads = () => store.streamingMetrics().reads;
  return { store, a, b, path, reads };
}
const texts = (store: Store, id: Parameters<Store["snapshotThread"]>[0]) =>
  Object.values(store.snapshotThread(id).items).map((item) =>
    item.type === "message"
      ? item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")
      : item.type,
  );

it("a write to a thread is visible to the next read of that thread", () => {
  const { store, a } = setup();
  expect(texts(store, a.id)).toEqual([]);
  store.appendEvents(a.id, [{ type: "item.created", item: message("one") }]);
  expect(texts(store, a.id)).toEqual(["one"]);
  store.appendEvents(a.id, [{ type: "thread.updated", title: "Renamed" }]);
  expect(store.snapshotThread(a.id).thread.title).toBe("Renamed");
  expect(store.readItems(a.id, Number.MAX_SAFE_INTEGER, 10).items.map((item) => item.id)).toEqual([
    "one",
  ]);
  store.appendEvents(a.id, [{ type: "item.created", item: message("two") }]);
  expect(store.readItems(a.id, Number.MAX_SAFE_INTEGER, 10).items.map((item) => item.id)).toEqual([
    "one",
    "two",
  ]);
});

it("a write to one thread keeps another thread's reads cached, at the current head", () => {
  const { store, a, b, reads } = setup();
  store.appendEvents(b.id, [{ type: "item.created", item: message("b") }]);
  const first = store.snapshotThread(b.id);
  const page = store.readItems(b.id, Number.MAX_SAFE_INTEGER, 10);
  store.appendEvents(a.id, [{ type: "item.created", item: message("a") }]);
  const hits = reads().hits;
  const again = store.snapshotThread(b.id);
  const pageAgain = store.readItems(b.id, Number.MAX_SAFE_INTEGER, 10);
  expect(reads().hits).toBe(hits + 2);
  expect(again.items).toEqual(first.items);
  expect(pageAgain.items).toEqual(page.items);
  // As a fresh read would say: nothing of b's changed through the current head.
  expect(pageAgain.seq).toBe(store.headSeq());
  expect(texts(store, a.id)).toEqual(["a"]);
  expect(reads().staleServes).toBe(0);
});

it("another connection's write is visible to the next read", () => {
  const { store, a, path } = setup();
  store.appendEvents(a.id, [{ type: "item.created", item: message("one", "before") }]);
  expect(texts(store, a.id)).toEqual(["before"]);
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout = 5000");
  other
    .prepare("UPDATE items SET item = json_set(item, '$.parts[0].text', 'elsewhere') WHERE id = ?")
    .run("one");
  other.close();
  expect(texts(store, a.id)).toEqual(["elsewhere"]);
});

it("a local write outside the event writer drops every cached read", () => {
  const { store, a, b, reads } = setup();
  store.appendEvents(a.id, [{ type: "item.created", item: message("one", "before") }]);
  expect(texts(store, a.id)).toEqual(["before"]);
  store.snapshotThread(b.id);
  // A direct write with no event, as maintenance or an import does.
  store
    .statement("UPDATE items SET item = json_set(item, '$.parts[0].text', 'after') WHERE id = ?")
    .run("one");
  const misses = reads().misses;
  expect(texts(store, a.id)).toEqual(["after"]);
  store.snapshotThread(b.id);
  expect(reads().misses).toBe(misses + 2);
});

it("a write hook's own rows are not taken for the event's thread", () => {
  const { store, a, b, reads } = setup();
  store.appendEvents(b.id, [{ type: "item.created", item: message("b", "before") }]);
  expect(texts(store, b.id)).toEqual(["before"]);
  const stop = store.onWrite(() => {
    store
      .statement("UPDATE items SET item = json_set(item, '$.parts[0].text', 'hooked') WHERE id = ?")
      .run("b");
  });
  store.appendEvents(a.id, [{ type: "thread.updated", title: "Touch a" }]);
  stop();
  const misses = reads().misses;
  expect(texts(store, b.id)).toEqual(["hooked"]);
  expect(reads().misses).toBe(misses + 1);
});

it("a held view sees a write made outside the event writer", () => {
  const { store, a } = setup();
  const view = store.acquireThread(a.id);
  cleanup.push(() => store.releaseThread(a.id));
  store.snapshotThread(a.id);
  store.statement("UPDATE threads SET title = ? WHERE id = ?").run("Direct", a.id);
  expect(store.snapshotThread(a.id).thread.title).toBe("Direct");
  expect(view.thread.title).toBe("Direct");
});
