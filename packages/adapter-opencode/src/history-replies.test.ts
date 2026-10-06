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
        { type: "text", text: "Offshift summary" },
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
    text: "Offshift summary",
  });
  const replies = Object.values(h.view.items).filter(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expect(replies).toHaveLength(3);
  expect(
    replies.filter(
      (item) =>
        item.type === "message" &&
        item.parts.some((part) => part.type === "text" && part.text === "Offshift summary"),
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
    text: "Offshift summary",
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
          { type: "text", text: "Offshift summary" },
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
    parts: [{ type: "text", text: "Offshift summary" }],
  });
});
