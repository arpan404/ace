import { expect, test } from "vitest";
import { createPiTranslator } from "./index.ts";
import { ThreadId } from "@ace/protocol";
import { replay } from "./testing/harness.ts";

test("final messages preserve unknown native data without multiplying raw bytes by block count", () => {
  const translator = createPiTranslator({ threadId: ThreadId.parse("raw-bound"), rootKey: "root" });
  const data = {
    type: "message_end",
    future: "f".repeat(800_000),
    message: {
      role: "assistant",
      content: Array.from({ length: 128 }, (_, i) => ({
        type: "text",
        text: String(i),
        unknown: i,
      })),
      stopReason: "stop",
    },
  };
  const facts = translator.translate({ seq: 1, t: 0, dir: "recv", channel: "stdio", data }, 0);
  const diagnostics = translator.takeDiagnostics?.() ?? [];
  expect(diagnostics).toEqual([]);
  const encoded = JSON.stringify(facts);
  expect(encoded.length).toBeLessThan(JSON.stringify(data).length * 3);
  expect(encoded).toContain(data.future);
  const messages = facts.filter(
    (fact) => fact.type === "item.upsert" && fact.draft.type === "message",
  );
  expect(messages).toHaveLength(128);
  expect(encoded).toContain('"unknown":127');
});
test("a Pi message with 300 streamed and final blocks keeps every block and completes", () => {
  const h = replay();
  h.recv({ type: "agent_start" });
  h.recv({ type: "message_start" });
  for (let i = 0; i < 300; i++)
    h.recv({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: i, delta: `b${i}` },
    });
  h.recv({
    type: "message_end",
    message: {
      role: "assistant",
      content: Array.from({ length: 300 }, (_, i) => ({ type: "text", text: `b${i}` })),
      stopReason: "stop",
    },
  });
  h.recv({ type: "agent_settled" });
  expect(h.state.status.state).toBe("done");
  const messages = Object.values(h.state.items).filter((item) => item.type === "message");
  expect(messages).toHaveLength(300);
  expect(messages.every((item) => item.complete)).toBe(true);
});
test("cumulative multi-block shell output appends boundary separators and only new text", () => {
  const h = replay();
  h.recv({ type: "agent_start" });
  h.recv({
    type: "tool_execution_start",
    toolCallId: "shell",
    toolName: "bash",
    args: { command: "build" },
  });
  for (const texts of [
    ["abc", "de"],
    ["abc", "def"],
    ["abc", "def", "g"],
    ["abc", "def", "gh"],
  ])
    h.recv({
      type: "tool_execution_update",
      toolCallId: "shell",
      partialResult: { content: texts.map((text) => ({ type: "text", text })) },
    });
  h.recv({
    type: "tool_execution_end",
    toolCallId: "shell",
    result: {
      content: [
        { type: "text", text: "abc" },
        { type: "text", text: "def" },
        { type: "text", text: "ghi" },
      ],
    },
  });
  h.recv({ type: "agent_settled" });
  const call = h.state.items["pi:tool:shell"];
  if (call?.type !== "tool_call" || call.call.detail.kind !== "shell")
    throw new Error("Missing shell output");
  expect(call.call.detail.output?.tail).toBe("abc\ndef\nghi");
  expect(call.call.detail.output?.bytes).toBe(11);
});
