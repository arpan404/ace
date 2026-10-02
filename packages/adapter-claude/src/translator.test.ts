import { nextDeadline } from "@ace/core";
import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";
import { createTranslator } from "./translator.ts";

test("an interrupted root waits while its background shell survives", () => {
  const h = harness();
  h.init();
  h.tool("bash", "Bash", { command: "long", run_in_background: true });
  h.system("task_started", {
    task_id: "b",
    task_type: "local_bash",
    tool_use_id: "bash",
    is_backgrounded: true,
  });
  h.result({ is_error: true, terminal_reason: "aborted_streaming", stop_reason: "tool_use" });
  expect(h.state.status).toMatchObject({ state: "waiting", on: "background_task" });
  expect(h.state.agents["root"]?.agent.status).toMatchObject({
    state: "blocked",
    on: "background_task",
  });
  expect(nextDeadline(h.state)).toBeUndefined();
  h.system("task_updated", { task_id: "b", patch: { status: "killed" } });
  h.tick(5010);
  expect(h.state.status.state).toBe("done");
  expect(h.state.agents["root"]?.agent.status.state).toBe("interrupted");
});
test("level-set removal holds a wake gap and marks a missing terminal edge unknown", () => {
  const h = harness();
  h.init();
  h.system("background_tasks_changed", {
    tasks: [{ task_id: "b", task_type: "local_bash", description: "loop" }],
  });
  h.result();
  h.send({ type: "system", subtype: "background_tasks_changed", tasks: [] }, "sdk", "recv", 100);
  h.tick(1099);
  expect(Object.values(h.state.tasks)[0]?.status).toBe("running");
  h.tick(1100);
  expect(Object.values(h.state.tasks)[0]?.status).toBe("unknown");
  expect(h.state.status.state).toBe("working");
  h.tick(5100);
  expect(h.state.status.state).toBe("done");
});
test("ambient watchers do not hold a finished thread open or schedule a wake", () => {
  const h = harness();
  h.init();
  h.system("background_tasks_changed", {
    tasks: [{ task_id: "watch", task_type: "monitor", ambient: true }],
  });
  h.result();
  expect(h.state.status.state).toBe("done");
  h.system("background_tasks_changed", { tasks: [] });
  expect(h.state.status.state).toBe("done");
});
test("a completion during a turn anchors its wake grace at the result", () => {
  const h = harness();
  h.init();
  h.system("task_started", { task_id: "b", task_type: "local_bash", is_backgrounded: true });
  h.system("task_notification", { task_id: "b", status: "completed" });
  h.send({ type: "result", terminal_reason: "completed" }, "sdk", "recv", 1000);
  expect(h.state.status.state).toBe("working");
  h.tick(5999);
  expect(h.state.status.state).toBe("working");
  h.tick(6000);
  expect(h.state.status.state).toBe("done");
});
test("a child permission arriving before task registration belongs to one linked child", () => {
  const h = harness();
  h.init();
  h.send(
    {
      toolName: "Bash",
      input: { command: "pwd" },
      options: { requestId: "r", toolUseID: "bash", agentID: "a" },
    },
    "can_use_tool",
  );
  expect(h.state.status.state).toBe("needs_you");
  h.system("task_started", {
    task_id: "a",
    task_type: "local_agent",
    tool_use_id: "spawn",
    prompt: "count",
  });
  h.tool("spawn", "Agent", { prompt: "count" });
  const children = Object.values(h.state.agents)
    .map((r) => r.agent)
    .filter((a) => a.parentId !== null);
  expect(children).toHaveLength(1);
  expect(children[0]?.native.nativeId).toBe("a");
  expect(children[0]?.spawnedBy).toBe(
    h.items().find((item) => item.type === "tool_call" && item.call.kind === "agent.spawn")?.id,
  );
  expect(Object.values(h.state.interactions)[0]?.agentId).toBe(children[0]?.id);
  h.send(
    { requestId: "r", result: { behavior: "allow", updatedInput: {} } },
    "can_use_tool",
    "send",
  );
  h.system("task_notification", { task_id: "a", status: "completed" });
  h.result();
  expect(h.state.status.state).toBe("done");
});
test("recursive spawn keys link a grandchild to its actual parent", () => {
  const h = harness();
  h.init();
  h.tool("spawn", "Agent");
  h.send({
    type: "assistant",
    parent_tool_use_id: "spawn",
    message: {
      id: "nested",
      content: [{ type: "tool_use", id: "grand", name: "Agent", input: {} }],
    },
  });
  h.system("task_started", { task_id: "g", tool_use_id: "grand", task_type: "local_agent" });
  expect(h.state.status.state).not.toBe("done");
  h.system("task_started", { task_id: "parent", tool_use_id: "spawn", task_type: "local_agent" });
  const agents = Object.values(h.state.agents).map((r) => r.agent);
  const grandchild = agents.find((a) => a.native.nativeId === "g");
  const parent = agents.find((a) => a.native.nativeId === "parent");
  expect(parent).toMatchObject({ origin: "provider_subagent" });
  expect(grandchild).toMatchObject({ parentId: parent?.id, native: { nativeId: "g" } });
});
test("terminal task enrichment does not restart a finished child", () => {
  const h = harness();
  h.init();
  h.tool("spawn", "Agent", { run_in_background: true });
  h.system("task_started", {
    task_id: "a",
    tool_use_id: "spawn",
    task_type: "local_agent",
    is_backgrounded: true,
  });
  h.system("task_updated", { task_id: "a", patch: { status: "completed" } });
  h.system("background_tasks_changed", { tasks: [{ task_id: "a", task_type: "local_agent" }] });
  const child = Object.values(h.state.agents).find((r) => r.agent.native.nativeId === "a");
  expect(child?.agent.status.state).toBe("idle");
});
test("streamed text is replaced by the complete assistant message without duplication", () => {
  const h = harness();
  h.init();
  const event = (nativeEvent: unknown) =>
    h.send({ type: "stream_event", event: nativeEvent, parent_tool_use_id: null });
  event({ type: "message_start", message: { id: "m" } });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } });
  expect(h.items().find((i) => i.type === "message")).toMatchObject({
    parts: [{ type: "text", text: "hello" }],
    complete: false,
  });
  event({ type: "content_block_stop", index: 0 });
  h.send({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hello" }] } });
  expect(h.items().filter((i) => i.type === "message")).toHaveLength(1);
  expect(h.items().find((i) => i.type === "message")).toMatchObject({
    parts: [{ type: "text", text: "hello" }],
    complete: true,
  });
});
test("permission-rule denial declines the tool while the turn continues", () => {
  const h = harness();
  h.init();
  h.tool("plan", "ExitPlanMode", { plan: "# plan" });
  h.send({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "plan", is_error: true, content: "No" }],
    },
    tool_result_meta: [{ id: "plan", non_execution_kind: "permission-rule" }],
  });
  expect(h.items().find((i) => i.type === "tool_call")).toMatchObject({
    call: { status: "declined" },
  });
  expect(h.state.status.state).toBe("working");
});
test("SDK error text fails the turn without treating ordinary auth prose as an error", () => {
  const failed = harness();
  failed.init();
  failed.send({
    type: "assistant",
    error: "authentication_failed",
    message: { id: "e", content: [{ type: "text", text: "Please log in" }] },
  });
  failed.result();
  expect(failed.state.agents["root"]?.agent.status).toMatchObject({
    state: "failed",
    error: { kind: "auth", message: "Please log in" },
  });
  const normal = harness();
  normal.init();
  normal.send({
    type: "assistant",
    message: {
      id: "m",
      content: [{ type: "text", text: "The Gmail connector needs authorization." }],
    },
  });
  normal.result();
  expect(normal.state.status.state).toBe("done");
});
test("cancelled questions stop waiting for a human and cannot be resolved by late replies", () => {
  const h = harness();
  h.init();
  h.send(
    {
      toolName: "AskUserQuestion",
      input: { questions: [{ question: "Tabs?", options: [{ label: "Tabs" }] }] },
      options: { requestId: "r", toolUseID: "ask" },
    },
    "can_use_tool",
  );
  expect(h.state.status.state).toBe("needs_you");
  h.send({ type: "control_cancel_request", request_id: "r" });
  h.send({ requestId: "r", result: { behavior: "allow" } }, "can_use_tool", "send");
  expect(Object.values(h.state.interactions)[0]?.state).toBe("cancelled");
});
test("process death expires open approvals and marks surviving tasks unknown", () => {
  const h = harness();
  h.init();
  h.system("task_started", { task_id: "b", task_type: "local_bash", is_backgrounded: true });
  h.send(
    { toolName: "Edit", input: {}, options: { requestId: "r", toolUseID: "edit" } },
    "can_use_tool",
  );
  h.send({ type: "process.exited", deliberate: false, message: "gone" }, "lifecycle", "note");
  expect(Object.values(h.state.interactions)[0]?.state).toBe("expired");
  expect(Object.values(h.state.tasks)[0]?.status).toBe("unknown");
  expect(h.state.status.state).toBe("failed");
});
test("unknown and malformed JSON frames survive in raw without throwing", () => {
  const h = harness();
  h.init();
  for (const value of [
    null,
    7,
    [],
    { type: "new_native_type", extra: { future: true } },
    { type: "system", subtype: "new_subtype" },
    { type: "assistant", message: { content: [{ type: "future_block", payload: 4 }] } },
  ])
    h.send(value);
  expect(
    h
      .items()
      .filter((i) => i.type === "notice")
      .flatMap((i) => {
        const payload = i.raw[0];
        return payload && "data" in payload ? [payload.data] : [];
      }),
  ).toContainEqual({ type: "new_native_type", extra: { future: true } });
  h.tool("future", "toString", { arbitrary: "input" });
  expect(h.items().find((i) => i.type === "tool_call")).toMatchObject({
    call: { kind: "custom", raw: [expect.objectContaining({ name: "toString" })] },
  });
  const translator = createTranslator({ rootKey: "root" });
  expect(() =>
    translator.translate(
      { seq: 0, t: 0, dir: "recv", channel: "sdk", data: { type: "stream_event", event: null } },
      0,
    ),
  ).not.toThrow();
});
test("late background result origin preserves the child wake trigger", () => {
  const h = harness();
  h.init();
  h.tool("spawn", "Agent", { run_in_background: true });
  h.system("task_started", {
    task_id: "a",
    task_type: "local_agent",
    tool_use_id: "spawn",
    is_backgrounded: true,
  });
  h.result();
  h.system("task_notification", { task_id: "a", status: "completed" });
  h.init();
  h.result({ origin: { kind: "task-notification" } });
  expect(
    Object.values(h.state.runs)
      .toReversed()
      .find((r) => r.agentId === h.state.agents["root"]?.agent.id)?.trigger,
  ).toBe("subagent_result");
});

// Browser artifact entries broaden Item, while provider output remains AgentItem.
test("provider notices keep their source payload through subsequent assistant output", () => {
  const h = harness();
  h.init();
  const unknown = { type: "future-provider-frame", marker: "browser-integration-raw" };
  h.send(unknown);
  h.send({
    type: "assistant",
    message: { id: "next", content: [{ type: "text", text: "next answer" }] },
  });
  h.result();
  const notice = h
    .items()
    .find(
      (item) =>
        item.type === "notice" &&
        item.raw.some(
          (payload) =>
            "data" in payload && JSON.stringify(payload.data).includes("browser-integration-raw"),
        ),
    );
  expect(notice).toMatchObject({ type: "notice", complete: true, raw: [{ data: unknown }] });
  expect(
    h
      .items()
      .find(
        (item) =>
          item.type === "message" &&
          item.parts.some((part) => part.type === "text" && part.text === "next answer"),
      ),
  ).toMatchObject({ type: "message", complete: true });
});
