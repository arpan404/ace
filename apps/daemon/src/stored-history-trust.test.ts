import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemId, ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message } from "./payload-test-support.ts";
import { Store } from "./store.ts";

// History revisions, text previews, item lookups and search replay read rows this build wrote
// as stored, and decode older rows (ADR 0125). A store's "shape" stands in for a build.

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-stored-history-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store: Store | undefined;
  const open = (eventShape: string) => {
    store?.close();
    store = new Store(path, console.error, { eventShape });
    return store;
  };
  cleanup.push(() => store?.close());
  return { open };
}

/** A thread with `count` messages, written by the build `shape`. */
function written(shape: string, count: number) {
  const { open } = setup();
  const store = open(shape);
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  for (let index = 0; index < count; index++)
    store.appendEvents(thread.id, [
      { type: "item.created", item: message(`m${index}`, `text ${index} `.repeat(index + 1)) },
    ]);
  return { open, store, thread: thread.id };
}

/** Strip a defaulted field from stored JSON, as an older build might have left it. */
function strip(store: Store, sql: string, ...params: string[]) {
  store.atomic((db) => db.prepare(sql).run(...params));
}

const page = (store: Store, thread: ThreadId, byteLimit = 1024 * 1024) =>
  store.readHistoricalItemPage(
    thread,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    50,
    byteLimit,
  );

it("history revisions written before a schema change are decoded with the new defaults", () => {
  const { open, store, thread } = written("older build", 1);
  strip(store, "UPDATE history_item_revisions SET item = json_remove(item, '$.complete')");

  const items = page(open("newer build"), thread).items;
  expect(items).toEqual([expect.objectContaining({ id: "m0", complete: true })]);
});

it("an item's completion read from an older revision gets the new defaults", () => {
  const { open, store, thread } = written("older build", 1);
  strip(store, "UPDATE history_item_revisions SET item = json_remove(item, '$.synthetic')");

  const after = open("newer build");
  const { item } = after.historicalItemCompletion(thread, "m0" as ItemId);
  expect(item).toMatchObject({ id: "m0", synthetic: false });
});

it("history pages read and break at the same item whether revisions are trusted or decoded", () => {
  const { open, store, thread } = written("build A", 6);
  const whole = page(store, thread).items;
  const budget =
    512 + whole.slice(-3).reduce((sum, item) => sum + JSON.stringify(item).length + 4 + 64, 0);
  const trusted = page(store, thread, budget);

  const decoded = page(open("build B"), thread, budget);
  expect(trusted).toEqual(decoded);
  expect(trusted.items.map((item) => item.id)).toEqual(["m3", "m4", "m5"]);
  expect(page(open("build B"), thread).items).toEqual(whole);
});

it("text previews of items created before a schema change are decoded with the new defaults", () => {
  const { open } = setup();
  const before = open("older build");
  const thread = createDevThread(before, before.createWorkspace("/repo", "Repo", 1));
  const text = "a".repeat(3000) + "b".repeat(3000);
  before.appendEvents(thread.id, [{ type: "item.created", item: message("long", text) }]);
  strip(before, "UPDATE item_previews SET item = json_remove(item, '$.complete')");

  // A finished message previews from its start; one read as unfinished would preview its tail.
  const [item] = open("newer build").readItemPage(thread.id, Number.MAX_SAFE_INTEGER, 10).items;
  expect(item).toMatchObject({
    id: "long",
    complete: true,
    parts: [{ type: "text", text: text.slice(0, 4096) }],
  });
});

it("an item looked up by id is decoded when an older build created it", () => {
  const { open, store, thread } = written("older build", 1);
  strip(store, "UPDATE items SET item = json_remove(item, '$.complete')");

  expect(open("newer build").measurements.item(thread, "m0")).toEqual(message("m0", "text 0 "));
});

const searchPage = (store: Store, maxBytes = 512 * 1024) =>
  store.readSearchPage({ afterSeq: 0, limit: 256, maxBytes });

it("search replay decodes events written before a schema change with the new defaults", () => {
  const { open, store } = written("older build", 1);
  strip(
    store,
    "UPDATE events SET payload = json_remove(payload, '$.item.complete') WHERE type = 'item.created'",
  );

  const events = searchPage(open("newer build")).events;
  expect(events).toContainEqual(
    expect.objectContaining({
      payload: { type: "item.created", item: message("m0", "text 0 ") },
    }),
  );
});

it("search replay pages break at the same event whether rows are trusted or decoded", () => {
  const { open, store } = written("build A", 12);
  const whole = searchPage(store);
  const trusted = searchPage(store, 2048);

  const reader = open("build B");
  expect(searchPage(reader, 2048)).toEqual(trusted);
  expect(searchPage(reader)).toEqual(whole);
  expect(trusted.events.length).toBeGreaterThan(1);
  expect(trusted.events.length).toBeLessThan(whole.events.length);
});
