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
/** What the line reads with the sender's current title, as a client that lists it knows it. */
const sent = (shown: EventView, title?: string) => {
  if (shown.kind !== "sent") throw new Error(`Expected a sent message, got ${shown.kind}`);
  return {
    line: sentByLine(shown.sent, title),
    provider: shown.sent.provider,
    threadId: shown.sent.threadId,
    text: shown.text,
  };
};

test("a brief thread_start sent names the starting thread by its current title and links to it", () => {
  const brief = message("Fix the flaky upload test.", {
    kind: "parent_agent",
    parentThreadId: "starter",
    from: { provider: "claude" },
  });
  expect(sent(view(brief, { startedBy: "starter" }), "Redesign Sidebar")).toEqual({
    line: "Sent by Redesign Sidebar",
    provider: "claude",
    threadId: "starter",
    text: "Fix the flaky upload test.",
  });
  // Renamed later, it reads the new title; before its title is known, it says where it came from.
  expect(sent(view(brief), "Sidebar v2").line).toBe("Sent by Sidebar v2");
  expect(sent(view(brief)).line).toBe("Sent from another thread");
});

test("a thread_start brief stored before its sender was stamped borrows the thread's starter", () => {
  const brief = message("Fix the flaky upload test.", { kind: "parent_agent", commandId: "c-1" });
  expect(sent(view(brief, { startedBy: "starter" }))).toMatchObject({ threadId: "starter" });
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
  expect(sent(view(task, thread), "Greeter work")).toEqual({
    line: "Sent by Greeter work",
    provider: "codex",
    threadId: "parent",
    text: "Write a greet() helper.",
  });
  expect(sent(view(steer, thread), "Greeter work")).toMatchObject({
    line: "Sent by Greeter work",
    threadId: "parent",
    text: "Also cover the empty name.",
  });
});

test("a child delegated from a paired machine names its parent there and, quietly, that machine", () => {
  const delegatedFrom = {
    hostId: "host-mac",
    hostName: "Arpan's MacBook Pro",
    threadId: "remote-parent",
    threadTitle: "Redesign Sidebar for Easier Navigation",
    provider: "claude" as const,
  };
  const launch = view(message("Run the iOS tests.", { kind: "spawn", role: "ios" }), {
    delegatedFrom,
  });
  const steer = view(message("Now on iOS 26.", { kind: "parent_agent", commandId: "c" }), {
    delegatedFrom,
  });
  for (const shown of [launch, steer]) {
    expect(sent(shown)).toMatchObject({
      line: "Sent by Redesign Sidebar for Easier Navigation · Arpan's MacBook Pro",
      provider: "claude",
      threadId: "remote-parent",
    });
  }
  const untitled = view(message("Run the iOS tests.", { kind: "spawn" }), {
    delegatedFrom: { ...delegatedFrom, threadTitle: undefined },
  });
  expect(sent(untitled).line).toBe("Sent from another thread · Arpan's MacBook Pro");
});

test("an agent message with no origin is sent from another thread, linked nowhere", () => {
  const native = Item.parse({
    ...message('<agent-message from="a92">\nFYI: my Swift now compiles.\n</agent-message>'),
    synthetic: true,
  });
  expect(sent(view(native, { delegatedBy: "parent" }))).toEqual({
    line: "Sent from another thread",
    provider: undefined,
    threadId: undefined,
    text: "FYI: my Swift now compiles.",
  });
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
