import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { eventView, type EventCounts, type EventView } from "./event-view.ts";
import { sentByLine, type SentByThread } from "./sent-by.ts";

let ids = 0;
const message = (text: string, origin?: Record<string, unknown>): Item =>
  Item.parse({
    id: `m-${++ids}`,
    agentId: "root",
    createdAt: ids,
    complete: true,
    type: "message",
    role: "user",
    parts: [{ type: "text", text }],
    ...(origin ? { origin } : {}),
  });
const counts: EventCounts = { repeated: false, echoed: false, refusals: 1, failures: 1 };
const view = (item: Item, thread?: SentByThread) => eventView(item, counts, "codex", thread);
const sent = (shown: EventView) => {
  if (shown.kind !== "sent") throw new Error(`Expected a sent message, got ${shown.kind}`);
  return { line: sentByLine(shown.sent), threadId: shown.sent.threadId, text: shown.text };
};

test("a brief thread_start sent shows as sent by its agent, linked to the starter", () => {
  const brief = message("Fix the flaky upload test.", {
    kind: "parent_agent",
    parentThreadId: "starter",
    from: { provider: "claude" },
  });
  expect(sent(view(brief, { startedBy: "starter" }))).toEqual({
    line: "Sent by Claude Code from another thread",
    threadId: "starter",
    text: "Fix the flaky upload test.",
  });
});

test("a thread_start brief stored before its sender was stamped borrows the thread's starter", () => {
  const brief = message("Fix the flaky upload test.", { kind: "parent_agent", commandId: "c-1" });
  expect(sent(view(brief, { startedBy: "starter" }))).toMatchObject({
    line: "Sent from another thread",
    threadId: "starter",
  });
});

test("a delegated task shows its words without ace's role frame, and a steer names its sender", () => {
  const task = message("Role: greeter\n\nTask:\nWrite a greet() helper.", {
    kind: "spawn",
    parentThreadId: "parent",
    role: "greeter",
    from: { provider: "codex" },
  });
  const steer = message("Also cover the empty name.", {
    kind: "parent_agent",
    parentThreadId: "parent",
    from: { provider: "codex" },
  });
  const thread = { delegatedBy: "parent" };
  expect(sent(view(task, thread))).toEqual({
    line: "Sent by Codex from another thread",
    threadId: "parent",
    text: "Write a greet() helper.",
  });
  expect(sent(view(steer, thread))).toMatchObject({
    line: "Sent by Codex from another thread",
    threadId: "parent",
    text: "Also cover the empty name.",
  });
});

test("a child delegated from a paired machine names that machine and its parent there", () => {
  const thread: SentByThread = {
    delegatedFrom: {
      hostId: "host-mac",
      hostName: "Arpan's MacBook Pro",
      threadId: "remote-parent",
      provider: "claude",
    },
  };
  const launch = view(message("Run the iOS tests.", { kind: "spawn", role: "ios" }), thread);
  const steer = view(message("Now on iOS 26.", { kind: "parent_agent", commandId: "c" }), thread);
  for (const shown of [launch, steer]) {
    expect(shown).toMatchObject({
      kind: "sent",
      sent: { threadId: "remote-parent", host: { id: "host-mac" } },
    });
    expect(sent(shown).line).toBe("Sent by Claude Code from another thread on Arpan's MacBook Pro");
  }
});

test("an agent message with no origin is sent from another thread, linked nowhere", () => {
  const native = Item.parse({
    ...message('<agent-message from="a92">\nFYI: my Swift now compiles.\n</agent-message>'),
    synthetic: true,
  });
  expect(sent(view(native, { delegatedBy: "parent" }))).toEqual({
    line: "Sent from another thread",
    threadId: undefined,
    text: "FYI: my Swift now compiles.",
  });
});

test("a sender that is a chat reads as another chat", () => {
  expect(sentByLine({ provider: "codex", threadId: "t" }, { chat: true })).toBe(
    "Sent by Codex from another chat",
  );
});

test("the person's own words, handoffs and automations are not sent by another thread", () => {
  expect(view(message("Please fix the build"))).toEqual({ kind: "user" });
  expect(view(message("Please fix the build", { kind: "steer" })).kind).not.toBe("sent");
  const handoff = message("Continue the refactor.", {
    kind: "spawn",
    role: "handoff: refactor",
    parentThreadId: "source",
  });
  expect(view(handoff)).toMatchObject({ kind: "task", prompt: { label: "Handoff" } });
  const automation = message("Nightly triage.", { kind: "automation" });
  expect(view(automation)).toMatchObject({ kind: "task", prompt: { label: "Automation" } });
});
