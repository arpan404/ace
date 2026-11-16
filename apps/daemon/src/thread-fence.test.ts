import { expect, test } from "vitest";
import { changesWork } from "./thread-fence.ts";

const person = { item: { type: "message", role: "user" } };
const output = { item: { type: "tool_call" } };

test.each([
  // Work the person didn't see: refused.
  ["a run starting", "run.started", { run: {} }, true],
  ["a message queued behind a run", "queue.updated", { revision: 3, pendingCount: 1 }, true],
  ["input admitted", "input.admitted", {}, true],
  ["a request raised", "interaction.opened", { interaction: {} }, true],
  ["a background task starting", "background_task.started", { task: {} }, true],
  ["a subagent starting", "agent.created", { agent: {} }, true],
  ["a person's message", "item.created", person, true],
  ["a switch to another model", "thread.updated", { switch: {} }, true],
  ["a queued launch", "thread.updated", { queuedLaunch: {} }, true],
  ["a type this build doesn't know", "thread.teleported", {}, true],
  ["an unknown provider event", "unknown", { raw: {} }, true],
  // Known not to matter: allowed.
  ["the work's own output", "item.delta", {}, false],
  ["a new step of work already running", "item.created", output, false],
  ["a run ending", "run.ended", {}, false],
  ["an agent's status", "agent.status", {}, false],
  ["a request closing", "interaction.closed", {}, false],
  ["a task's progress", "background_task.updated", {}, false],
  ["a rename", "thread.updated", { title: "New title", titleSource: "person" }, false],
  ["a status roll-up", "thread.updated", { status: { state: "working" } }, false],
  ["a pin", "thread.client.updated", { changes: { pinned: true, pinOrder: 2 } }, false],
  ["a snooze", "thread.client.updated", { changes: { snoozedUntil: 5, snoozeWake: null } }, false],
  ["read state", "thread.client.updated", { changes: { unread: false, readAt: 4 } }, false],
  [
    "a client field this build doesn't know",
    "thread.client.updated",
    { changes: { newField: 1 } },
    true,
  ],
] as const)("%s", (_, type, payload, changes) => {
  expect(changesWork(type, payload)).toBe(changes);
});
