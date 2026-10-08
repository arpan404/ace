import { createPiTranslator } from "./index.ts";
import type { Translator } from "@ace/engine-api";
import { expect, test } from "vitest";
import { replay } from "./testing/harness.ts";
const start = { type: "agent_start" };
const settled = { type: "agent_settled" };
const result = (text: string) => ({ content: [{ type: "text", text }] });
test("retry and compaction after agent end keep the thread live until Pi settles", () => {
  const h = replay();
  h.recv(start);
  h.recv({ type: "agent_end", willRetry: true });
  expect(h.state.status.state).toBe("working");
  h.recv({ type: "auto_retry_start", attempt: 1, errorMessage: "overloaded" });
  expect(h.state.status.state).toBe("waiting");
  h.recv({ type: "auto_retry_end", success: true });
  h.recv({ type: "compaction_start", reason: "overflow" });
  h.recv({ type: "compaction_end", willRetry: true });
  expect(h.state.status.state).not.toBe("done");
  h.recv(settled);
  expect(h.state.status.state).toBe("done");
});
test("a settled event leaves a dialog pending until its matching native answer", () => {
  const h = replay();
  h.recv(start);
  h.recv({ type: "extension_ui_request", id: "d", method: "input", title: "Value" });
  h.recv(settled);
  expect(h.state.status.state).toBe("needs_you");
  h.send({ type: "extension_ui_response", id: "other", value: "ignored" });
  expect(h.state.status.state).toBe("needs_you");
  h.send({ type: "extension_ui_response", id: "d", value: "answer" });
  expect(h.state.status.state).toBe("done");
});
test("native dialog timeout expires only the timed interaction", () => {
  const h = replay();
  h.recv(start);
  h.recv(
    { type: "extension_ui_request", id: "timed", method: "input", title: "Value", timeout: 20 },
    10,
  );
  h.recv({ type: "extension_ui_request", id: "open", method: "editor", title: "Edit" }, 10);
  h.recv(settled, 10);
  h.facts(h.translator.tick(29), 29);
  expect(h.state.interactions.timed?.state).toBe("pending");
  h.facts(h.translator.tick(30), 30);
  expect(h.state.interactions.timed?.state).toBe("expired");
  expect(h.state.interactions.open?.state).toBe("pending");
  expect(h.state.status.state).toBe("needs_you");
  h.send({ type: "extension_ui_response", id: "open", value: "answer" }, 31);
  expect(h.state.status.state).toBe("done");
});
test("deferred settlement keeps its failed outcome until the last dialog closes", () => {
  const h = replay();
  h.recv(start);
  h.recv({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error" } });
  h.recv({ type: "extension_ui_request", id: "first", method: "input" });
  h.recv({ type: "extension_ui_request", id: "last", method: "input", timeout: 10 });
  h.recv(settled);
  expect(h.state.interactions.first?.state).toBe("pending");
  h.send({ type: "extension_ui_response", id: "first", value: "answer" });
  expect(h.state.interactions.last?.state).toBe("pending");
  h.facts(h.translator.tick(10), 10);
  expect(h.state.interactions.last?.state).toBe("expired");
  expect(h.state.status.state).toBe("failed");
});
test("fire-and-forget and unknown extension updates retain raw data without blocking", () => {
  const h = replay();
  h.recv(start);
  const notification = {
    type: "extension_ui_request",
    id: "n",
    method: "notify",
    message: "hello",
  };
  h.recv(notification);
  expect(h.state.status.state).toBe("working");
  const unknown = { type: "future_event", future: { opaque: 42 } };
  h.recv(unknown);
  expect(h.state.status.state).toBe("working");
  h.recv(settled);
  expect(h.state.status.state).toBe("done");
  const notices = Object.values(h.state.items).filter((item) => item.type === "notice");
  expect(notices.map((item) => item.text)).toEqual(["hello"]);
  const retained = [...h.diagnostics, ...notices.flatMap((item) => item.raw)];
  expect(retained).toContainEqual({ type: notification.type, data: notification });
  expect(retained).toContainEqual({ type: unknown.type, data: unknown });
});
test("shell output appends only new suffixes and completion cannot erase surviving work", () => {
  const h = replay();
  h.recv(start);
  h.recv({
    type: "tool_execution_start",
    toolCallId: "shell",
    toolName: "bash",
    args: { command: "build" },
  });
  h.recv({ type: "tool_execution_update", toolCallId: "shell", partialResult: result("abc") });
  h.recv({ type: "tool_execution_update", toolCallId: "shell", partialResult: result("abcdef") });
  h.recv(settled);
  expect(h.state.status.state).toBe("waiting");
  h.recv({
    type: "tool_execution_end",
    toolCallId: "shell",
    result: result("abcdef"),
    isError: false,
  });
  expect(h.state.status.state).toBe("done");
  const call = h.state.items["pi:tool:shell"];
  expect(call?.type).toBe("tool_call");
  if (call?.type !== "tool_call" || call.call.detail.kind !== "shell") throw new Error("No shell");
  expect(call.call.detail.output?.bytes).toBe(6);
  expect(call.call.detail.output?.tail).toBe("abcdef");
});
test("streamed assistant text is not duplicated by the final authoritative message", () => {
  const h = replay();
  h.recv(start);
  h.recv({ type: "message_start", message: { role: "assistant", content: [] } });
  h.recv({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
  });
  h.recv({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stopReason: "stop",
      usage: { input: 2, output: 1 },
    },
  });
  h.recv(settled);
  const item = h.state.items["pi:message:1:0"];
  expect(item?.type === "message" ? item.parts : []).toEqual([{ type: "text", text: "hello" }]);
  expect(item?.complete).toBe(true);
});
test("live tool capacity overflow cannot turn into a successful settled thread", () => {
  const h = replay();
  h.recv(start);
  for (let i = 0; i < 257; i++)
    h.recv({ type: "tool_execution_start", toolCallId: String(i), toolName: "custom", args: {} });
  h.recv(settled);
  expect(h.state.status.state).not.toBe("done");
});
test("oversized blocking dialogs cannot be demoted to a notice and successful completion", () => {
  const h = replay();
  h.recv(start);
  h.recv({
    type: "extension_ui_request",
    id: "large",
    method: "select",
    options: Array.from({ length: 257 }, (_, index) => String(index)),
  });
  h.recv(settled);
  expect(h.state.status.state).not.toBe("done");
});
test("unexpected exit expires dialogs and does not report successful completion", () => {
  const h = replay();
  h.recv(start);
  h.recv({
    type: "extension_ui_request",
    id: "d",
    method: "select",
    title: "Choose",
    options: ["one"],
  });
  h.frame({
    seq: 3,
    t: 5,
    dir: "note",
    channel: "lifecycle",
    data: { type: "exited", deliberate: false },
  });
  expect(h.state.interactions.d?.state).toBe("expired");
  expect(h.state.status.state).toBe("failed");
});

test("reopened processes keep new runs and text separate from prior native counters", () => {
  const h = replay();
  function run(translator: Translator, processId: string, text: string) {
    let seq = 0;
    const feed = (data: unknown, dir: "recv" | "note" = "recv") =>
      h.facts(translator.translate({ seq: seq++, t: 0, dir, channel: "stdio", data }, 0), 0);
    feed({ type: "started", processId }, "note");
    feed({ type: "agent_start" });
    feed({ type: "message_start" });
    feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    });
    feed({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
    });
    feed({ type: "agent_settled" });
  }
  run(h.translator, "first", "one");
  run(createPiTranslator({ threadId: h.threadId, rootKey: "root" }), "second", "two");
  expect(Object.values(h.state.runs).length).toBe(2);
  expect(
    Object.values(h.state.items)
      .filter((item) => item.type === "message")
      .map((item) => (item.type === "message" ? item.parts : [])),
  ).toEqual([[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]]);
});

test("extension notifications and failed commands remain readable while routine UI updates stay diagnostic", () => {
  const h = replay();
  h.recv(start);
  const status = {
    type: "extension_ui_request",
    id: "s",
    method: "setStatus",
    statusText: "status.event",
  };
  h.recv(status);
  h.recv({
    type: "extension_ui_request",
    id: "n",
    method: "notify",
    message: "Build needs attention",
    notifyType: "warning",
  });
  h.recv({
    type: "response",
    command: "compact",
    success: false,
    error: "Context could not be compacted",
  });
  expect(Object.values(h.state.items).filter((item) => item.type === "notice")).toMatchObject([
    { text: "Build needs attention", level: "warning" },
    { text: "Context could not be compacted", level: "error" },
  ]);
  expect(h.diagnostics).toContainEqual({ type: "extension_ui_request", data: status });
  h.recv(settled);
  expect(h.state.status.state).toBe("done");
});

test("ace MCP error details fail a Pi tool even when Pi reports normal execution", () => {
  const h = replay();
  h.recv(start);
  h.recv({
    type: "tool_execution_start",
    toolCallId: "ace-error",
    toolName: "screen_click",
    args: { x: 1, y: 2 },
  });
  h.recv({
    type: "tool_execution_end",
    toolCallId: "ace-error",
    isError: false,
    result: {
      content: [{ type: "text", text: "Foreground required" }],
      details: { aceMcp: { isError: true } },
    },
  });
  h.recv(settled);
  const item = Object.values(h.state.items).find((entry) => entry.type === "tool_call");
  expect(item).toMatchObject({
    complete: true,
    call: { status: "failed", detail: { kind: "mcp", server: "ace", tool: "screen_click" } },
  });
});
