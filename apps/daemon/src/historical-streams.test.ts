import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Item, Thread } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { Store } from "@ace/daemon";
import { shell } from "./payload-test-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-history-revisions-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store = new Store(path, undefined, { now: () => 1 });
  cleanup.push(() => store.close());
  const workspaceId = store.createWorkspace(home, "Workspace", 1);
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    title: "Thread",
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
  return {
    get store() {
      return store;
    },
    thread,
    reopen() {
      store.close();
      store = new Store(path, undefined, { now: () => 1 });
    },
  };
}
function message(text: string) {
  const item = Item.parse({
    id: "message",
    agentId: "root",
    type: "message",
    role: "assistant",
    complete: true,
    createdAt: 1,
    parts: [{ type: "text", text }],
  });
  if (item.type !== "message") throw new Error("Invalid message fixture");
  return item;
}
test("historical text retains its original revision and appended prefix after replacement, deletion and replay", () => {
  const h = setup();
  const id = h.thread.id;
  const original = message("before");
  h.store.appendEvents(
    id,
    [
      { type: "item.created", item: original },
      {
        type: "item.delta",
        itemId: original.id,
        agentId: original.agentId,
        field: "text",
        append: " 🦊 cutoff",
      },
    ],
    2,
  );
  const through = h.store.headSeq();
  const read = () => h.store.readHistoricalItemPage(id, through, through + 1, 1).items[0];
  const item = read();
  const part = item?.type === "message" ? item.parts[0] : undefined;
  if (part?.type !== "text" || !part.source) throw new Error("No historical text source");
  const legacyStreamId = part.source.streamId;
  h.store.appendEvents(
    id,
    [
      {
        type: "item.delta",
        itemId: original.id,
        agentId: original.agentId,
        field: "text",
        append: " future",
      },
      { type: "item.updated", item: message("replacement secret") },
      { type: "item.deleted", itemId: original.id },
    ],
    3,
  );
  const assertHistory = () => {
    const value = read();
    expect(value).toMatchObject({ parts: [{ type: "text", text: "before 🦊 cutoff" }] });
    const text = value?.type === "message" ? value.parts[0] : undefined;
    if (text?.type !== "text" || !text.source) throw new Error("No historical text source");
    expect(h.store.historicalItemCount(id, through)).toBe(1);
    const chunk = h.store.readHistoricalStream(id, text.source.streamId, through, 0, 1024);
    expect(chunk.bytes.toString("utf16le")).toBe("before 🦊 cutoff");
    expect(chunk.eof).toBe(true);
  };
  assertHistory();
  // Model a pre-index preview migration that seeded the creation ID with a later body.
  h.store.atomic((db) => {
    db.prepare("UPDATE item_source_chunks SET bytes=? WHERE stream_id=? AND offset=0").run(
      Buffer.from("future", "utf16le"),
      legacyStreamId,
    );
    db.exec(
      "DELETE FROM history_item_revisions; DELETE FROM history_stream_versions; DELETE FROM history_items; DELETE FROM history_inventory; DELETE FROM history_index_migration",
    );
  });
  h.reopen();
  assertHistory();
});

test("startup rebuild restores retired shell chunks and masks output appended beyond the historical cutoff", () => {
  const h = setup();
  const id = h.thread.id;
  const shell = Item.parse({
    id: "shell",
    agentId: "root",
    type: "tool_call",
    complete: false,
    createdAt: 1,
    call: {
      id: "shell",
      agentId: "root",
      kind: "shell",
      title: "Build",
      status: "running",
      startedAt: 1,
      raw: [],
      detail: { kind: "shell", command: "build" },
    },
  });
  if (shell.type !== "tool_call") throw new Error("Invalid shell fixture");
  h.store.appendEvents(
    id,
    [
      { type: "item.created", item: shell },
      {
        type: "item.delta",
        itemId: shell.id,
        agentId: shell.agentId,
        field: "output",
        append: "original 🦊\n",
      },
    ],
    2,
  );
  const through = h.store.headSeq();
  const historical = h.store.readHistoricalItemPage(id, through, through + 1, 1).items[0];
  if (
    historical?.type !== "tool_call" ||
    historical.call.detail.kind !== "shell" ||
    !historical.call.detail.output
  )
    throw new Error("No output stream");
  const streamId = historical.call.detail.output.streamId;
  h.store.appendEvents(
    id,
    [
      {
        type: "item.delta",
        itemId: shell.id,
        agentId: shell.agentId,
        field: "output",
        append: "future secret\n",
      },
      { type: "item.deleted", itemId: shell.id },
    ],
    3,
  );
  h.store.atomic((db) =>
    db.exec(
      "DELETE FROM history_item_revisions; DELETE FROM history_stream_versions; DELETE FROM history_items; DELETE FROM history_inventory; DELETE FROM history_index_migration; DELETE FROM output_streams",
    ),
  );
  h.reopen();
  expect(h.store.readHistoricalStream(id, streamId, through, 0, 1024)).toMatchObject({
    bytes: Buffer.from("original 🦊\n"),
    eof: true,
  });
  expect(JSON.stringify(h.store.readHistoricalItemPage(id, through, through + 1, 1))).not.toContain(
    "future secret",
  );
});

test("historical shell tails preserve whole UTF-8 characters at the byte boundary across reopen", () => {
  const h = setup();
  const item = shell();
  const output = "🦊".repeat(1025) + "x";
  h.store.appendEvents(
    h.thread.id,
    [
      { type: "item.created", item },
      {
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: "output",
        append: output,
      },
    ],
    2,
  );
  const through = h.store.headSeq();
  const assertHistory = () => {
    const historical = h.store.readHistoricalItemPage(h.thread.id, through, through + 1, 1)
      .items[0];
    if (historical?.type !== "tool_call" || historical.call.detail.kind !== "shell")
      throw new Error("Missing historical shell");
    const summary = historical.call.detail.output;
    if (!summary) throw new Error("Missing output pointer");
    expect(summary.tail).toBe("🦊".repeat(1023) + "x");
    expect(summary.bytes).toBe(Buffer.byteLength(output));
    expect(summary.truncated).toBe(true);
    const chunk = h.store.readHistoricalStream(h.thread.id, summary.streamId, through, 0, 8192);
    expect(chunk.bytes).toEqual(Buffer.from(output));
    expect(chunk.eof).toBe(true);
  };
  assertHistory();
  h.reopen();
  assertHistory();
});
