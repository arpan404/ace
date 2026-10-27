import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { queueActionPayload, queuePauseControl } from "./queue-actions.ts";

const threadId = ThreadId.parse("thread-1");
const flowing = { revision: 7, paused: false, reason: null } as const;

test("pause and resume fence the queue to the revision the person saw", () => {
  expect(queueActionPayload({ id: "hold", label: "Pause queue" }, threadId, flowing)).toEqual({
    type: "queue.pause",
    threadId,
    expectedRevision: 7,
  });
  expect(
    queueActionPayload({ id: "resume", label: "Resume" }, threadId, {
      revision: 8,
      paused: true,
      reason: "manual",
    }),
  ).toEqual({ type: "queue.resume", threadId, expectedRevision: 8 });
});

test("resuming after a restart resumes the thread's native session", () => {
  const held = { revision: 2, paused: true, reason: "restart" } as const;
  expect(queueActionPayload({ id: "resume", label: "Resume" }, threadId, held)?.type).toBe(
    "thread.resume",
  );
  expect(queueActionPayload({ id: "continue", label: "Continue" }, threadId, held)?.type).toBe(
    "thread.resume",
  );
});

test("continue after a stop is the person's own next message", () => {
  const payload = queueActionPayload({ id: "continue", label: "Continue" }, threadId, {
    revision: 3,
    paused: true,
    reason: "stopped",
  });
  expect(payload).toMatchObject({ type: "thread.send", threadId, delivery: "queue" });
  expect(payload?.type === "thread.send" && payload.input[0]).toMatchObject({ type: "text" });
});

test("limit choices go to the daemon as thread.limit, moving to a named account", () => {
  expect(
    queueActionPayload({ id: "resume_at_reset", label: "Resume at reset" }, threadId, flowing),
  ).toEqual({ type: "thread.limit", threadId, expectedRevision: 7, action: "resume_at_reset" });
  expect(
    queueActionPayload(
      { id: "migrate_now", label: "Move to Work", instanceId: "work-1" },
      threadId,
      flowing,
    ),
  ).toEqual({
    type: "thread.limit",
    threadId,
    expectedRevision: 7,
    action: "migrate_now",
    instanceId: "work-1",
  });
});

test("picking another model is the client's own sheet, not a command", () => {
  expect(
    queueActionPayload({ id: "choose_model", label: "Pick another model" }, threadId, flowing),
  ).toBeUndefined();
});

test("the queue offers Pause while messages wait and Resume only after the person's own pause", () => {
  expect(queuePauseControl(flowing, 2)?.label).toBe("Pause queue");
  expect(queuePauseControl(flowing, 0)).toBeUndefined();
  expect(queuePauseControl({ paused: true, reason: "manual" }, 1)).toEqual({
    id: "resume",
    label: "Resume queue",
  });
  expect(queuePauseControl({ paused: true, reason: "limit" }, 1)).toBeUndefined();
  expect(queuePauseControl({ paused: true, reason: "not_sent" }, 1)).toBeUndefined();
});
