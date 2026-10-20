import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentId, AgentItem, ItemId, type ThreadId } from "@ace/protocol";
import { Store, createDevThread } from "./index.ts";

const homes: string[] = [];
afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function home(): string {
  const path = mkdtempSync(join(tmpdir(), "ace-item-copies-"));
  homes.push(path);
  return join(path, "events.sqlite");
}
function shell(id: string, status: "running" | "succeeded") {
  return AgentItem.parse({
    id,
    agentId: "agent",
    type: "tool_call",
    createdAt: 1,
    complete: status === "succeeded",
    call: {
      id,
      agentId: "agent",
      kind: "shell",
      title: "bun run test",
      status,
      startedAt: 1,
      raw: [{ type: "provider", data: { command: "bun run test", note: "x".repeat(4096) } }],
      detail: { kind: "shell", command: "bun run test" },
    },
  });
}
const message = (id: string, text: string) =>
  AgentItem.parse({
    id,
    agentId: "agent",
    type: "message",
    role: "assistant",
    createdAt: 2,
    complete: true,
    parts: [{ type: "text", text }],
  });

function writeTranscript(store: Store, thread: ThreadId) {
  store.appendEvents(thread, [{ type: "item.created", item: shell("tool", "running") }]);
  store.appendEvents(thread, [
    {
      type: "item.delta",
      itemId: ItemId.parse("tool"),
      agentId: AgentId.parse("agent"),
      field: "output",
      append: "hello\n",
    },
  ]);
  // Like the engine, the final update carries the output the stream gave the call.
  const running = store.readItemPage(thread, Number.MAX_SAFE_INTEGER, 50).items[0];
  if (running?.type !== "tool_call" || running.call.detail.kind !== "shell")
    throw new Error("No running tool");
  const done = shell("tool", "succeeded");
  if (done.type === "tool_call" && done.call.detail.kind === "shell")
    done.call.detail.output = running.call.detail.output;
  store.appendEvents(thread, [{ type: "item.updated", item: done }]);
  store.appendEvents(thread, [{ type: "item.created", item: message("answer", "all green") }]);
  store.flushLiveWrites();
  return done;
}
function readTranscript(store: Store, thread: ThreadId) {
  const page = store.readItemPage(thread, Number.MAX_SAFE_INTEGER, 50).items;
  const tool = page.find((item) => item.id === "tool");
  if (tool?.type !== "tool_call" || tool.call.detail.kind !== "shell") throw new Error("No tool");
  const stream = tool.call.detail.output?.streamId;
  if (!stream) throw new Error("No output stream");
  return {
    page: page.map((item) => item.id),
    status: tool.call.status,
    raw: tool.call.raw.length,
    completed: store.historicalItemCompletion(thread, ItemId.parse("tool")).item,
    output: Buffer.from(store.readOutput(stream, 0, 1024).bytes, "base64").toString(),
    outputOwner: store.outputThread(stream),
  };
}
function previews(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT id FROM item_previews ORDER BY id")
      .all()
      .map((row) => String(row.id));
  } finally {
    db.close();
  }
}

test("a tool call keeps one stored body yet still pages, replays history and streams output", async () => {
  const path = home();
  let store = new Store(path);
  const thread = createDevThread(store, store.createWorkspace("/repo", "repo")).id;
  const done = writeTranscript(store, thread);
  const expected = {
    page: ["tool", "answer"],
    status: "succeeded",
    raw: 1,
    completed: done,
    output: "hello\n",
    outputOwner: thread,
  };
  expect(readTranscript(store, thread)).toMatchObject(expected);
  await store.close();
  // Only the text item has a preview: the tool call's body lives in its item row alone.
  expect(previews(path)).toEqual(["answer"]);
  store = new Store(path);
  try {
    expect(readTranscript(store, thread)).toMatchObject(expected);
  } finally {
    await store.close();
  }
});
