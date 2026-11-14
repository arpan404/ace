import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message } from "./payload-test-support.ts";
import { Store } from "./store.ts";
import { buildIdFile, runningBuildId, storedTrustBuild } from "./stored-shape.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** A store whose event schema "shape" the test chooses, standing in for different builds. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-stored-shape-"));
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

function appendMessage(store: Store, thread: ThreadId, id: string) {
  return store.appendEvents(thread, [{ type: "item.created", item: message(id) }]);
}

/** Rewrite a stored item event as an older build might have left it: without `complete`. */
function dropComplete(store: Store, seq: number) {
  store.atomic((db) =>
    db
      .prepare("UPDATE events SET payload = json_remove(payload, '$.item.complete') WHERE seq = ?")
      .run(seq),
  );
}

function storedItem(store: Store, seq: number) {
  const event = store.readEvents({ afterSeq: seq - 1, limit: 1 })[0];
  if (event?.payload.type !== "item.created") throw new Error("expected an item event");
  return event.payload.item;
}

it("events this build wrote read back exactly as they were appended", () => {
  const { open } = setup();
  const store = open("current");
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(store, workspace);
  const appended = [
    ...appendMessage(store, thread.id, "first"),
    ...appendMessage(store, thread.id, "second"),
  ];
  const first = appended[0];
  if (!first) throw new Error("nothing appended");
  expect(store.readEvents({ afterSeq: first.seq - 1, limit: 10 })).toEqual(appended);
});

it("rows written before a schema change are decoded with the new schema's defaults", () => {
  const { open } = setup();
  const before = open("older build");
  const workspace = before.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(before, workspace);
  const [event] = appendMessage(before, thread.id, "old");
  if (!event) throw new Error("nothing appended");
  dropComplete(before, event.seq);

  const after = open("newer build");
  expect(storedItem(after, event.seq)).toMatchObject({ id: "old", complete: true });
});

it("rows a different build wrote in between are decoded again after coming back", () => {
  const { open } = setup();
  const first = open("build A");
  const workspace = first.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(first, workspace);
  appendMessage(first, thread.id, "from A");

  const other = open("build B");
  const [written] = appendMessage(other, thread.id, "from B");
  if (!written) throw new Error("nothing appended");
  dropComplete(other, written.seq);

  const back = open("build A");
  expect(storedItem(back, written.seq)).toMatchObject({ id: "from B", complete: true });
});

it("replay pages break at the same event whether rows are trusted or decoded", () => {
  const { open } = setup();
  const writer = open("build A");
  const workspace = writer.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(writer, workspace);
  for (let index = 0; index < 6; index++) appendMessage(writer, thread.id, `m${index}`);
  const all = writer.readEvents({ afterSeq: 0, limit: 100 });
  const budget = all.slice(0, 4).reduce((sum, event) => sum + JSON.stringify(event).length, 0);
  const trusted = writer.readEvents({ afterSeq: 0, limit: 100, byteLimit: budget });

  const reader = open("build B");
  const decoded = reader.readEvents({ afterSeq: 0, limit: 100, byteLimit: budget });
  expect(trusted.map((event) => event.seq)).toEqual(decoded.map((event) => event.seq));
  expect(trusted).toHaveLength(5);
});

it("thread items created before a schema change are decoded with the new schema's defaults", () => {
  const { open } = setup();
  const before = open("older build");
  const workspace = before.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(before, workspace);
  appendMessage(before, thread.id, "old item");
  before.atomic((db) =>
    db
      .prepare("UPDATE items SET item = json_remove(item, '$.complete') WHERE id = ?")
      .run("old item"),
  );

  const after = open("newer build");
  const page = after.readItems(thread.id, Number.MAX_SAFE_INTEGER, 10);
  expect(page.items).toContainEqual(expect.objectContaining({ id: "old item", complete: true }));
});

it("thread items this build created read back as they were appended", () => {
  const { open } = setup();
  const store = open("current");
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(store, workspace);
  appendMessage(store, thread.id, "new item");
  const page = store.readItems(thread.id, Number.MAX_SAFE_INTEGER, 10);
  expect(page.items).toContainEqual(message("new item"));
});

/** A release directory holding a daemon build id, as the bundle step writes it. */
function releaseDirectory(name: string, id: string | undefined) {
  const directory = join(mkdtempSync(join(tmpdir(), "ace-trust-build-")), name);
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(directory);
  if (id !== undefined) writeFileSync(join(directory, buildIdFile), `${id}\n`);
  return directory;
}
const id = (digit: string) => digit.repeat(64);
/** The trust identity of a release whose files sit in `directory`. */
const key = (directory: string, version = "1.2.3") =>
  storedTrustBuild(version, runningBuildId(directory));

it("the trust identity follows the build id beside the daemon, not just its version", () => {
  const first = releaseDirectory("first", id("a"));
  const rebuilt = releaseDirectory("rebuilt", id("a"));
  const patched = releaseDirectory("patched", id("b"));

  expect(key(first)).toBeDefined();
  expect(key(rebuilt)).toBe(key(first));
  expect(key(patched)).not.toBe(key(first));
  expect(key(first, "1.2.4")).not.toBe(key(first));
  expect(key(first, "development")).toBeUndefined();
});

it("a daemon without a readable build id keeps no trust identity", () => {
  expect(runningBuildId(releaseDirectory("missing", undefined))).toBeUndefined();
  expect(runningBuildId(releaseDirectory("malformed", "not a digest"))).toBeUndefined();
  expect(runningBuildId(import.meta.dirname)).toBeUndefined();
  expect(storedTrustBuild("1.2.3", undefined)).toBeUndefined();
});
