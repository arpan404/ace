import { Agent, Event, Interaction, Thread, type EventPayload } from "@ace/protocol";
import { expect, test } from "vitest";
import { liveMetadata, updateThread } from "./index.ts";

function settled() {
  return Thread.parse({
    id: "thread",
    workspaceId: "ace",
    title: "Work",
    provider: "codex",
    rootAgentId: "root",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 1,
    settledAt: 1,
    settledReason: "manual",
    autoSettleAt: 10,
  });
}

/** Apply the event and the metadata follow-up just as the daemon's writer does. */
function apply(thread: Thread, payload: EventPayload) {
  const followup = liveMetadata(thread, payload);
  const event = Event.parse({ id: "event", threadId: thread.id, seq: 1, at: 2, payload });
  updateThread(thread, event);
  if (followup) updateThread(thread, { ...event, seq: 2, payload: followup });
}

test.each([
  { state: "working", agents: 1 } as const,
  { state: "needs_you", interactions: 1 } as const,
])("new $state activity clears settlement before the thread is listed again", (status) => {
  const thread = settled();
  apply(thread, { type: "thread.updated", status });
  expect(thread.settledAt).toBeUndefined();
  expect(thread.settledReason).toBeUndefined();
  expect(thread.autoSettleAt).toBeUndefined();
});

test("settling an existing request survives repeated status and activity updates", () => {
  const thread = settled();
  thread.status = { state: "needs_you", interactions: 1 };
  apply(thread, { type: "thread.updated", status: thread.status });
  apply(thread, { type: "thread.client.updated", changes: { activityAt: 3 } });
  expect(thread.settledAt).toBe(1);
});

test("new child work clears settlement even when the parent's status is still done", () => {
  const thread = settled();
  const agent = Agent.parse({
    id: "child",
    parentId: "root",
    threadId: thread.id,
    provider: "codex",
    origin: "provider_subagent",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/tmp",
    status: { state: "working", activity: "thinking" },
    createdAt: 2,
  });
  apply(thread, { type: "agent.created", agent });
  expect(thread.settledAt).toBeUndefined();
  expect(thread.live?.runningSubagentCount).toBe(1);
});

test("a fresh question reopens a manually settled request, but replaying it does not", () => {
  const thread = settled();
  thread.status = { state: "needs_you", interactions: 1 };
  const interaction = Interaction.parse({
    id: "question",
    threadId: thread.id,
    agentId: "root",
    blocking: true,
    request: { kind: "question", questions: [{ id: "q", text: "Continue?", options: [] }] },
    state: "pending",
    createdAt: 2,
  });
  apply(thread, { type: "interaction.opened", interaction });
  expect(thread.settledAt).toBeUndefined();
  apply(thread, {
    type: "thread.client.updated",
    changes: { settledAt: 3, settledReason: "manual" },
  });
  apply(thread, { type: "interaction.opened", interaction });
  expect(thread.settledAt).toBe(3);
});
