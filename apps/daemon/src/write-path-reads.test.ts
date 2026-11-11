import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentId, type EventPayload, type ThreadId } from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { message, shell } from "./payload-test-support.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** A store whose event schema "shape" the test chooses, standing in for different builds. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-write-path-reads-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store: Store | undefined;
  const open = (eventShape: string) => {
    store?.close();
    store = new Store(path, console.error, { eventShape });
    return store;
  };
  cleanup.push(() => store?.close());
  /** The shell item's row as stored, read past the store. */
  const row = (): Record<string, unknown> => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return JSON.parse(
        String(db.prepare("SELECT item FROM items WHERE id = ?").get(shell().id)?.item),
      );
    } finally {
      db.close();
    }
  };
  return { open, row };
}
const output = (append: string): EventPayload => ({
  type: "item.delta",
  itemId: shell().id,
  agentId: AgentId.parse("root"),
  field: "output",
  append,
});
function startShell(store: Store): ThreadId {
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  store.appendEvents(thread.id, [{ type: "item.created", item: shell() }]);
  return thread.id;
}

it("output into a shell item an older build left is stored back in this build's shape", () => {
  const { open, row } = setup();
  const before = open("older build");
  const thread = startShell(before);
  // An older layout: the item has no `complete`, which this schema fills in as true.
  before.atomic((db) =>
    db
      .prepare("UPDATE items SET item = json_remove(item, '$.complete') WHERE id = ?")
      .run(shell().id),
  );
  expect(row()).not.toHaveProperty("complete");

  const after = open("newer build");
  after.appendEvents(thread, [output("hello\n")]);
  expect(row()).toMatchObject({ id: shell().id, complete: true });
});

it("output into a shell item this build created keeps the item as it was appended", () => {
  const { open, row } = setup();
  const store = open("current");
  const thread = startShell(store);
  store.appendEvents(thread, [output("one\n"), output("two\n")]);
  expect(row()).toMatchObject({
    id: shell().id,
    type: "tool_call",
    complete: false,
    call: { status: "running", raw: [], detail: { kind: "shell", command: "echo" } },
  });
  const snapshot = store.snapshotThread(thread).items[shell().id];
  expect(snapshot).toMatchObject({ id: shell().id, complete: false });
});

it("a message's history keeps each revision as it was written", () => {
  const { open } = setup();
  const store = open("current");
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  const [created] = store.appendEvents(thread.id, [
    { type: "item.created", item: { ...message("answer", "first draft"), complete: false } },
  ]);
  const [updated] = store.appendEvents(thread.id, [
    { type: "item.updated", item: message("answer", "final answer") },
  ]);
  if (!created || !updated) throw new Error("nothing appended");
  const at = (through: number) =>
    store.readHistoricalItemPage(thread.id, through, Number.MAX_SAFE_INTEGER, 10).items;
  const shown = (items: ReturnType<typeof at>) =>
    items.map((item) => ({
      complete: item.complete,
      text:
        item.type === "message" ? item.parts.map((part) => part.type === "text" && part.text) : [],
    }));
  expect(shown(at(created.seq))).toEqual([{ complete: false, text: ["first draft"] }]);
  expect(shown(at(updated.seq))).toEqual([{ complete: true, text: ["final answer"] }]);
});
