import { expect, test } from "vitest";
import { harness } from "./replay.ts";
import { historyReplyFrames } from "./testing/history-replies.ts";

test("mixed history reconciles per-kind ordinals without merging equal replies from another message", () => {
  const h = harness();
  const frames = historyReplyFrames();
  for (const frame of frames.initial) h.feed(frame);
  let sequence = 100;
  const frame = (channel: string, data: unknown) =>
    h.feed({ seq: ++sequence, t: sequence, dir: "recv", channel, data });
  const event = (type: string, data: Record<string, unknown>) =>
    frame("sse", {
      id: `event-${sequence}`,
      type,
      data: { sessionID: "native-1", ...data },
    });
  event("session.reasoning.ended", {
    assistantMessageID: "answer",
    ordinal: 1,
    text: "Think again",
  });
  event("session.text.ended", { assistantMessageID: "answer", ordinal: 1, text: "Further detail" });
  const before = Object.values(h.view.items)
    .filter((item) => item.type === "message")
    .map((item) => item.id);
  frame("snapshot.message", {
    sessionID: "native-1",
    message: {
      id: "answer",
      type: "assistant",
      time: { completed: 10 },
      content: [
        { type: "reasoning", text: "Think" },
        {
          type: "tool",
          id: "read",
          name: "read",
          state: { status: "completed", input: { path: "/project" }, content: [] },
        },
        { type: "text", text: "Delegation summary" },
        { type: "reasoning", text: "Think again" },
        { type: "text", text: "Further detail" },
      ],
    },
  });
  expect(
    Object.values(h.view.items)
      .filter((item) => item.type === "message")
      .map((item) => item.id),
  ).toEqual(before);
  event("session.execution.started", {});
  event("session.text.ended", {
    assistantMessageID: "different-answer",
    ordinal: 0,
    text: "Delegation summary",
  });
  const replies = Object.values(h.view.items).filter(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expect(replies).toHaveLength(3);
  expect(
    replies.filter(
      (item) =>
        item.type === "message" &&
        item.parts.some((part) => part.type === "text" && part.text === "Delegation summary"),
    ),
  ).toHaveLength(2);
});

test("history after a new input updates the streamed answer even when reasoning precedes it", () => {
  const h = harness();
  let seq = 0;
  const frame = (channel: string, data: unknown) =>
    h.feed({ seq: ++seq, t: seq, dir: "recv", channel, data });
  const event = (type: string, data: Record<string, unknown> = {}) =>
    frame("sse", {
      id: `event-${seq}`,
      type,
      data: { sessionID: "native", ...data },
    });
  frame("snapshot.info", {
    root: true,
    info: { id: "native", projectID: "project", location: { directory: "/project" } },
  });
  event("session.execution.started");
  event("session.reasoning.ended", { assistantMessageID: "answer", ordinal: 0, text: "Think" });
  event("session.text.ended", {
    assistantMessageID: "answer",
    ordinal: 0,
    text: "Delegation summary",
  });
  event("session.execution.succeeded");
  const answer = Object.values(h.view.items).find((item) => item.type === "message");
  frame("snapshot.message", {
    sessionID: "native",
    message: { id: "next-input", type: "user", text: "List downloads" },
  });
  for (let replay = 0; replay < 2; replay++)
    frame("snapshot.message", {
      sessionID: "native",
      message: {
        id: "answer",
        type: "assistant",
        time: { completed: 10 },
        content: [
          { type: "reasoning", text: "Think" },
          { type: "text", text: "Delegation summary" },
        ],
      },
    });
  const replies = Object.values(h.view.items).filter(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({
    id: answer?.id,
    runId: answer?.runId,
    parts: [{ type: "text", text: "Delegation summary" }],
  });
});

test("permission, instruction and system schema records never become conversation items", () => {
  const h = harness();
  const frames = historyReplyFrames();
  for (const frame of frames.initial) h.feed(frame);
  const before = Object.values(h.view.items);
  let seq = 100;
  for (const type of ["session.permissions", "session.instructions.updated"])
    h.feed({
      seq: ++seq,
      t: seq,
      dir: "recv",
      channel: "sse",
      data: {
        id: `event-${seq}`,
        type,
        data: { sessionID: "native-1", instructions: "Internal tool schemas" },
      },
    });
  h.feed({
    seq: ++seq,
    t: seq,
    dir: "recv",
    channel: "snapshot.message",
    data: {
      sessionID: "native-1",
      message: { id: "system", type: "system", text: "Tool schemas: read, write, bash" },
    },
  });
  expect(Object.values(h.view.items)).toEqual(before);
  h.feed({
    seq: ++seq,
    t: seq,
    dir: "recv",
    channel: "sse",
    data: {
      id: `event-${seq}`,
      type: "session.text.ended",
      data: {
        sessionID: "native-1",
        assistantMessageID: "after-bookkeeping",
        ordinal: 0,
        text: "The task is complete.",
      },
    },
  });
  expect(Object.values(h.view.items)).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "assistant",
      parts: [{ type: "text", text: "The task is complete." }],
    }),
  );
});
