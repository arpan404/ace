import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentId, AgentItem, ItemId, type ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message, shell } from "./payload-test-support.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/**
 * One database read by two builds: the build that wrote it reads its rows as stored, another
 * build (a different event shape) decodes and validates every row. Both must see the same items.
 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-item-trusted-reads-"));
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

function streaming(id: string, type: "message" | "reasoning") {
  return AgentItem.parse(
    type === "message"
      ? { id, agentId: "root", type, role: "assistant", complete: false, createdAt: 1, parts: [] }
      : { id, agentId: "root", type, complete: false, createdAt: 1, text: "" },
  );
}

function tool(id: string, length: number) {
  const item = shell(id);
  if (item.type === "tool_call" && item.call.detail.kind === "shell")
    item.call.detail.command = "c".repeat(length);
  return { ...item, complete: true };
}

/** Finished and unfinished text, tool bodies of growing size, and deltas still unmerged. */
const live = ItemId.parse("live");
const thinking = ItemId.parse("thinking");
const owner = AgentId.parse("root");

function seed(store: Store): ThreadId {
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const thread = createDevThread(store, workspace).id;
  store.appendEvents(thread, [{ type: "item.created", item: message("done", "finished text") }]);
  for (let index = 0; index < 6; index++)
    store.appendEvents(thread, [
      { type: "item.created", item: tool(`tool-${index}`, 300 * index) },
    ]);
  store.appendEvents(thread, [{ type: "item.created", item: streaming("live", "message") }]);
  store.appendEvents(thread, [{ type: "item.created", item: streaming("thinking", "reasoning") }]);
  // Many small chunks, a surrogate pair split across two of them, and an empty append.
  const chunks = ["Hel", "lo ", "\ud83d", "\ude00", "", " wörld", ..."x".repeat(40)];
  for (const append of chunks) {
    store.appendEvents(thread, [
      { type: "item.delta", itemId: live, agentId: owner, field: "text", append },
    ]);
    store.appendEvents(thread, [
      { type: "item.delta", itemId: thinking, agentId: owner, field: "reasoning", append },
    ]);
  }
  store.appendEvents(thread, [{ type: "item.created", item: tool("tool-last", 50) }]);
  // Output rewrites the shell body in place, and its stored size with it.
  store.appendEvents(thread, [
    {
      type: "item.delta",
      itemId: ItemId.parse("tool-last"),
      agentId: owner,
      field: "output",
      append: "out\n",
    },
  ]);
  return thread;
}

/**
 * Everything the item read paths return for the thread, or the error each one throws. Values,
 * not JSON text: a validated row comes back in schema key order, a trusted one as written.
 */
function reads(store: Store, thread: ThreadId) {
  const attempt = (read: () => unknown) => {
    try {
      return read();
    } catch (error) {
      return `throws ${String(error)}`;
    }
  };
  const head = store.headSeq() + 1;
  const pages: unknown[] = [];
  for (let byteLimit = 600; byteLimit <= 4000; byteLimit += 7)
    pages.push(attempt(() => store.readItemPage(thread, head, 200, byteLimit)));
  return {
    snapshot: attempt(() => store.snapshotThread(thread).items),
    items: attempt(() => store.readItems(thread, head, 200)),
    page: attempt(() => store.readItemPage(thread, head, 200)),
    pages,
  };
}

it("rows this build wrote read the same as rows decoded and validated", () => {
  const { open } = setup();
  const writer = open("writer");
  const thread = seed(writer);
  const trusted = reads(writer, thread);
  const validated = reads(open("another build"), thread);
  expect(trusted).toEqual(validated);
});

it("text still streaming reads back with every chunk it was sent", () => {
  const { open } = setup();
  const store = open("writer");
  const thread = seed(store);
  const items = store.readItems(thread, store.headSeq() + 1, 200).items;
  const live = items.find((item) => item.id === "live");
  const thinking = items.find((item) => item.id === "thinking");
  const text = `Hello 😀 wörld${"x".repeat(40)}`;
  expect(live).toMatchObject({ complete: false, parts: [{ type: "text", text }] });
  expect(thinking).toMatchObject({ complete: false, text });
});

it("a thread snapshot shows the same items as a full item page, in creation order", () => {
  const { open } = setup();
  const store = open("writer");
  const thread = seed(store);
  const page = store.readItems(thread, store.headSeq() + 1, 200).items;
  const snapshot = store.snapshotThread(thread);
  expect(snapshot.items).toEqual(Object.fromEntries(page.map((item) => [item.id, item])));
  expect(snapshot.itemOrder).toEqual(page.map((item) => item.id));
});

it("a page at its byte budget keeps the items that fit and pages the rest", () => {
  const { open } = setup();
  const store = open("writer");
  const thread = seed(store);
  const head = store.headSeq() + 1;
  const whole = store.readItemPage(thread, head, 200);
  const sizes = whole.items.map(
    (item) =>
      Buffer.byteLength(JSON.stringify(item)) + Buffer.byteLength(JSON.stringify(item.id)) + 64,
  );
  // The newest two items exactly fill the budget (512 bytes of envelope plus their sizes).
  const budget = 512 + (sizes.at(-1) ?? 0) + (sizes.at(-2) ?? 0);
  const fitting = store.readItemPage(thread, head, 200, budget);
  expect(fitting.items).toEqual(whole.items.slice(-2));
  expect(fitting.itemsBefore).not.toBeNull();
  expect(store.readItemPage(thread, head, 200, budget - 1).items).toEqual(whole.items.slice(-1));
});
