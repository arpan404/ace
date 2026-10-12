import { host } from "../bridge/polyfills.ts";
/** Test-only entry point: the production pump and presenters, with native decoding in Swift. */
import { PatchPump } from "../bridge/patches.ts";
import { itemRow } from "../bridge/presentation.ts";
import { Item } from "@ace/protocol";

const pump = new PatchPump();
const largeId = "large-" + "x".repeat(100 * 1024);
let revision = 0;
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
function status() {
  pump.put("inbox:status", () => ({
    type: "inbox.row",
    id: "status",
    row: {
      id: "status",
      title: "Working",
      state: "working",
      attention: null,
      project: "ace",
      branch: "",
      machine: "",
      provider: "codex",
      model: "",
      agents: 2,
      snoozedUntil: null,
      updatedAt: 0,
      canSteer: false,
    },
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
  queueApproval: () => approval(false),
  replaceApproval: () => approval(false, "replacement-action-"),
  queueBrokenApproval: () => approval(true),
  acknowledge: (accepted: boolean) => pump.ack(accepted),
});
