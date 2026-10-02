import { apply } from "@ace/core";
import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

test("a provider result leaves input queued by the engine waiting", () => {
  const h = harness();
  h.init();
  let id = 0;
  apply(
    h.state,
    { type: "queue.changed", count: 1 },
    { now: 2, ids: { next: (kind) => `${kind}:${++id}` } },
  );
  h.result({ queued_turn_count: 0 });
  expect(h.state.status).toMatchObject({ state: "waiting", on: "queue" });
});
test("optional session-state events guard idle until the provider reports idle", () => {
  const h = harness();
  h.init();
  h.system("session_state_changed", { state: "running" });
  h.result();
  h.tick(10_000);
  expect(h.state.status.state).not.toBe("done");
  h.system("session_state_changed", { state: "idle" });
  expect(h.state.status.state).toBe("done");
});
test("a reopened provider process clears stale turns and namespaces reused native ids", () => {
  const h = harness();
  h.send(
    { type: "process.started", session_id: "s", process_id: "one", cwd: "/repo" },
    "lifecycle",
    "note",
  );
  h.init();
  h.tool("same", "Read", { file_path: "a.ts" });
  h.send({ type: "process.exited", deliberate: false }, "lifecycle", "note");
  h.send(
    { type: "process.started", session_id: "s", process_id: "two", cwd: "/repo" },
    "lifecycle",
    "note",
  );
  h.init();
  h.tool("same", "Read", { file_path: "b.ts" });
  h.result();
  const tools = h.items().filter((item) => item.type === "tool_call");
  expect(tools).toHaveLength(2);
  expect(Object.values(h.state.runs)).toHaveLength(2);
  expect(h.state.status.state).toBe("done");
});
test("a foreground child's parent stays blocked on the child while the child works", () => {
  const h = harness();
  h.init();
  h.tool("spawn", "Agent");
  h.system("task_started", { task_id: "a", task_type: "local_agent", tool_use_id: "spawn" });
  expect(h.state.agents["root"]?.agent.status).toMatchObject({ state: "blocked", on: "subagents" });
  expect(h.state.status.state).toBe("working");
});
test("question text and option labels remain the native answer keys", () => {
  const h = harness();
  h.init();
  h.send(
    {
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Tabs or Spaces?",
            header: "Indentation",
            options: [{ label: "Tabs", description: "Use tabs" }],
            multiSelect: false,
          },
        ],
      },
      options: { requestId: "r", toolUseID: "ask" },
    },
    "can_use_tool",
  );
  expect(h.state.agents["root"]?.agent.status).toMatchObject({ state: "blocked", on: "human" });
  expect(Object.values(h.state.interactions)[0]?.request).toMatchObject({
    kind: "question",
    questions: [{ id: "Tabs or Spaces?", options: [{ id: "Tabs" }] }],
  });
  h.send(
    {
      requestId: "r",
      result: { behavior: "allow", updatedInput: { answers: { "Tabs or Spaces?": "Tabs" } } },
    },
    "can_use_tool",
    "send",
  );
  expect(Object.values(h.state.interactions)[0]?.resolution).toEqual({
    kind: "question",
    answers: { "Tabs or Spaces?": ["Tabs"] },
  });
});
test("separate complete thinking and text blocks keep their streamed identities and raw metadata", () => {
  const h = harness();
  h.init();
  const event = (native: unknown) => h.send({ type: "stream_event", event: native });
  event({ type: "message_start", message: { id: "m" } });
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
    future: "kept",
  });
  event({ type: "content_block_stop", index: 0 });
  h.send({
    type: "assistant",
    message: { id: "m", content: [{ type: "thinking", thinking: "reason", signature: "sig" }] },
  });
  event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } });
  event({ type: "content_block_stop", index: 1 });
  h.send({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "answer" }] } });
  expect(h.items().filter((item) => item.type === "message")).toHaveLength(1);
  expect(h.items().find((item) => item.type === "reasoning")).toMatchObject({
    text: "reason",
    complete: true,
    raw: expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({ event: expect.objectContaining({ future: "kept" }) }),
      }),
    ]),
  });
  expect(h.items().find((item) => item.type === "message")).toMatchObject({
    parts: [{ type: "text", text: "answer" }],
    complete: true,
  });
});
test("requesting stays at starting-turn until content arrives, then returns to thinking", () => {
  const h = harness();
  h.init();
  h.system("status", { status: "requesting" });
  expect(h.state.agents["root"]?.agent.status).toMatchObject({
    state: "working",
    activity: "starting_turn",
  });
  h.send({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hello" }] } });
  h.system("status", { status: "requesting" });
  expect(h.state.agents["root"]?.agent.status).toMatchObject({
    state: "working",
    activity: "thinking",
  });
});
test("an aborted result finalizes partial text even without a content-block stop", () => {
  const h = harness();
  h.init();
  h.send({ type: "stream_event", event: { type: "message_start", message: { id: "partial" } } });
  h.send({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });
  h.send({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    },
  });
  h.result({ is_error: true, terminal_reason: "aborted_streaming" });
  expect(h.items().find((item) => item.type === "message")).toMatchObject({
    parts: [{ type: "text", text: "partial" }],
    complete: true,
  });
  expect(h.state.status.state).toBe("done");
});
test("a child returns to thinking between tool completion and its next content", () => {
  const h = harness();
  h.init();
  h.tool("spawn", "Agent");
  h.system("task_started", { task_id: "a", tool_use_id: "spawn", task_type: "local_agent" });
  h.send({
    type: "assistant",
    parent_tool_use_id: "spawn",
    message: {
      id: "child-m",
      content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "a" } }],
    },
  });
  h.send({
    type: "user",
    parent_tool_use_id: "spawn",
    message: { content: [{ type: "tool_result", tool_use_id: "read", content: "ok" }] },
  });
  expect(
    Object.values(h.state.agents).find((record) => record.agent.native.nativeId === "a")?.agent
      .status,
  ).toMatchObject({ state: "working", activity: "thinking" });
});
