import { host } from "../bridge/polyfills.ts";
/** Test-only entry point: the production pump and presenters, with native decoding in Swift. */
import { PatchPump } from "../bridge/patches.ts";
import { itemRow, threadRow } from "../bridge/presentation.ts";
import { Item, ThreadListEntry } from "@ace/protocol";
import { itemDetail } from "../bridge/thread-rows.ts";
import { workLog } from "../bridge/work-log.ts";
import { installHistoryScenarios } from "./transcript-history.ts";

installHistoryScenarios();

const pump = new PatchPump();
const largeId = "large-" + "x".repeat(100 * 1024);
let revision = 0;
function queueWorkFlow() {
  const common = { agentId: "agent", createdAt: 0, complete: true };
  const edit = (id: string, path: string) =>
    Item.parse({
      ...common,
      id,
      type: "tool_call",
      call: {
        id,
        agentId: "agent",
        kind: "file.edit",
        title: `Edit ${path}`,
        status: "succeeded",
        raw: [],
        startedAt: 0,
        detail: {
          kind: "file.edit",
          changes: [{ path, kind: "update", oldText: "old", newText: "new" }],
        },
      },
    });
  const entries = [
    Item.parse({
      ...common,
      id: "thought",
      type: "reasoning",
      text: "Check how progress is grouped.",
    }),
    edit("edit-1", "one.swift"),
    edit("edit-2", "two.swift"),
    Item.parse({
      ...common,
      id: "narration",
      type: "message",
      role: "assistant",
      parts: [{ type: "text", text: "The layout is fixed. Checking the result." }],
    }),
  ];
  const items = new Map<string, Item>(entries.map((item) => [item.id, item]));
  entries.forEach((item, index) =>
    pump.put(`thread:item:${item.id}`, () => ({
      type: "thread.item",
      threadId: "thread",
      epoch: 1,
      id: item.id,
      row: { ...itemRow(item, index), ...itemDetail(item) },
    })),
  );
  pump.put("thread:block:flow", () => ({
    type: "thread.block",
    threadId: "thread",
    epoch: 1,
    id: "flow",
    row: {
      index: 0,
      kind: "work",
      items: entries.map((item) => item.id),
      headed: false,
      interactionId: "",
      work: {
        label: "Working",
        counts: "Edited 2 files",
        current: "",
        ongoing: true,
        outcome: "",
        startedAt: 0,
        failed: 0,
      },
      log: workLog(
        entries.map((item) => item.id),
        (id) => items.get(id),
      ).rows,
    },
  }));
}
function content(id: string, text: string) {
  const item = Item.parse({
    id,
    agentId: "agent",
    createdAt: host.now(),
    complete: false,
    type: "tool_call",
    call: {
      id,
      agentId: "agent",
      kind: "shell",
      title: text,
      status: "running",
      detail: { kind: "shell", command: "echo test" },
      startedAt: 0,
      raw: [],
    },
  });
  pump.put(`thread:item:${id}`, () => ({
    type: "thread.item",
    threadId: "thread",
    epoch: 1,
    id,
    row: itemRow(item, 0),
  }));
}
function visualization(id: string, title: string) {
  const item = Item.parse({
    id,
    agentId: "agent",
    createdAt: host.now(),
    complete: true,
    type: "html",
    visualization: {
      title,
      document: {
        sha256: "a".repeat(64),
        bytes: 128,
        mimeType: "text/html",
        name: "visualization.html",
      },
    },
  });
  pump.put(`thread:item:${id}`, () => ({
    type: "thread.item",
    threadId: "thread",
    epoch: 1,
    id,
    row: itemRow(item, 0),
  }));
}
function status() {
  pump.put("inbox:status", () => ({
    type: "inbox.row",
    id: "status",
    row: threadRow(
      ThreadListEntry.parse({
        id: "status",
        workspaceId: "ace",
        title: "Working",
        provider: "codex",
        createdAt: 0,
        updatedAt: 0,
        status: { state: "working", agents: 2 },
        live: { subagentCount: 1, backgroundTaskCount: 0 },
      }),
    ),
  }));
}
function approval(broken: boolean, optionPrefix = "action-") {
  pump.put("thread:interaction:approval", () => ({
    type: "thread.interaction",
    threadId: "thread",
    epoch: 1,
    id: "approval",
    row: {
      id: "approval",
      kind: "approval",
      state: "pending",
      title: broken ? "\udc00" : "Review",
      description: "",
      command: "echo test",
      truncated: false,
      options: [{ id: optionPrefix + "x".repeat(32768), label: "Allow once", kind: "allow_once" }],
    },
  }));
}
function brokenContent(invalidIdentity: boolean) {
  pump.put("thread:item:poison", () => ({
    type: "thread.item",
    threadId: "thread",
    epoch: 1,
    id: "poison",
    row: {
      id: invalidIdentity ? "\udc00" : "poison",
      index: 1,
      type: "tool_call",
      role: "",
      text: "\udc00",
      complete: false,
      createdAt: 0,
      agentId: "agent",
      truncated: false,
    },
  }));
}
Object.assign(globalThis, {
  queueWorkFlow,
  queueBrokenContent: () => brokenContent(false),
  queueInvalidIdentity: () => brokenContent(true),
  repairIdentity: () => brokenContent(false),
  replacePoison: () => content("poison", "Recovered content"),
  queueReset: () =>
    pump.put("thread:reset", () => ({ type: "thread.reset", threadId: "thread", epoch: 1 })),
  queueMalformedDisplay: () => content("malformed", "\udc00a"),
  queueUnicode: () => content("unicode", "😀" + "x".repeat(8191)),
  updateLarge: () => content(largeId, `revision ${++revision}`),
  queueSibling: () => content("sibling", "A later content row"),
  queueStatus: status,
  queueVisualization: () => visualization("visualization", "Latency by region"),
  queueApproval: () => approval(false),
  replaceApproval: () => approval(false, "replacement-action-"),
  queueBrokenApproval: () => approval(true),
  acknowledge: (accepted: boolean) => pump.ack(accepted),
});
