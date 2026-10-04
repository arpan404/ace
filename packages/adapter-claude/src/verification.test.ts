import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

const register = (h: ReturnType<typeof harness>, id = "C", spawn = "launch") =>
  h.system("task_started", { task_id: id, tool_use_id: spawn, task_type: "local_agent" });
const paragraph = (h: ReturnType<typeof harness>, id: string, spawn = "launch") =>
  h.send({
    type: "assistant",
    parent_tool_use_id: spawn,
    message: {
      id,
      content: [{ type: "text", text: id }],
      usage: {
        input_tokens: 11,
        output_tokens: id === "first" ? 4 : 7,
        cache_read_input_tokens: 2,
      },
    },
  });
const permission = (h: ReturnType<typeof harness>, id = "C") =>
  h.send(
    {
      toolName: "Read",
      input: { file_path: "file" },
      options: { requestId: id, toolUseID: `read:${id}`, agentID: id },
    },
    "can_use_tool",
  );
const allow = (h: ReturnType<typeof harness>, id = "C") =>
  h.send({ requestId: id, result: { behavior: "allow" } }, "can_use_tool", "send");

test("child transcript before permission and binding belongs to one settled child", () => {
  const h = harness();
  h.init();
  h.tool("launch", "Agent");
  paragraph(h, "first");
  permission(h);
  register(h);
  allow(h);
  h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
  h.result();
  expect(Object.values(h.state.agents)).toHaveLength(2);
  expect(Object.values(h.state.runs)).toHaveLength(2);
  expect(h.state.status.state).toBe("done");
  const child = Object.values(h.state.agents).find((a) => a.agent.native.nativeId === "C");
  expect(h.items().find((i) => i.type === "message" && i.role === "assistant")?.agentId).toBe(
    child?.agent.id,
  );
  expect(Object.values(h.state.interactions)[0]?.agentId).toBe(child?.agent.id);
  expect(
    h.items().find((i) => i.type === "tool_call" && i.call.kind === "file.read")?.agentId,
  ).toBe(child?.agent.id);
});
test("two unbound transcripts and reversed native permissions reconcile without guessing", () => {
  const h = harness();
  h.init();
  h.tool("launch", "Agent");
  h.tool("other", "Agent");
  paragraph(h, "first", "launch");
  paragraph(h, "second", "other");
  permission(h, "D");
  permission(h, "C");
  register(h, "C", "launch");
  register(h, "D", "other");
  allow(h, "C");
  allow(h, "D");
  for (const id of ["C", "D"])
    h.system("task_updated", { task_id: id, patch: { status: "completed" } });
  h.result();
  expect(Object.values(h.state.agents)).toHaveLength(3);
  expect(Object.values(h.state.runs)).toHaveLength(3);
  expect(h.state.status.state).toBe("done");
  for (const [text, native] of [
    ["first", "C"],
    ["second", "D"],
  ]) {
    const child = Object.values(h.state.agents).find((a) => a.agent.native.nativeId === native);
    expect(
      h
        .items()
        .find(
          (i) => i.type === "message" && i.parts.some((p) => p.type === "text" && p.text === text),
        )?.agentId,
    ).toBe(child?.agent.id);
  }
});
for (const status of ["completed", "failed", "killed"])
  test(`a ${status} task remains terminal after late registration and transcript`, () => {
    const h = harness();
    h.init();
    h.system("task_updated", { task_id: "C", patch: { status } });
    register(h);
    paragraph(h, "late");
    h.result();
    expect(h.state.status.state).toBe("done");
    expect(Object.values(h.state.runs).filter((r) => r.state === "active")).toHaveLength(0);
    expect(
      Object.values(h.state.agents).find((a) => a.agent.native.nativeId === "C")?.agent.status
        .state,
    ).toBe(status === "completed" ? "idle" : status === "failed" ? "failed" : "interrupted");
  });
test("terminal transcript replays preserve cumulative child usage", () => {
  const h = harness();
  h.init();
  register(h);
  paragraph(h, "first");
  paragraph(h, "second");
  h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
  paragraph(h, "second");
  paragraph(h, "first");
  const child = Object.values(h.state.agents).find((a) => a.agent.native.nativeId === "C");
  const updates = h.events.filter(
    (e) => e.type === "usage.updated" && e.agentId === child?.agent.id,
  );
  expect(updates.at(-1)).toMatchObject({ inputTokens: 26, outputTokens: 11, cachedInputTokens: 4 });
  expect(
    updates
      .slice(2)
      .every((e) => e.type === "usage.updated" && e.inputTokens === 26 && e.outputTokens === 11),
  ).toBe(true);
});
test("a stale usage refinement cannot reduce an already reported message", () => {
  const h = harness();
  h.init();
  register(h);
  const usage = (output_tokens: number) =>
    h.send({
      type: "assistant",
      parent_tool_use_id: "launch",
      message: {
        id: "same",
        content: [{ type: "text", text: "same" }],
        usage: { input_tokens: 11, output_tokens },
      },
    });
  usage(4);
  usage(7);
  usage(4);
  expect(h.events.findLast((e) => e.type === "usage.updated")).toMatchObject({
    inputTokens: 11,
    outputTokens: 7,
  });
});
test("a reappearing task cancels its old missing deadline without affecting another", () => {
  const h = harness();
  h.init();
  h.send(
    {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "one" }, { task_id: "two" }],
    },
    "sdk",
    "recv",
    10,
  );
  h.send({ type: "system", subtype: "background_tasks_changed", tasks: [] }, "sdk", "recv", 100);
  h.send(
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "one" }] },
    "sdk",
    "recv",
    200,
  );
  h.send({ type: "keep_alive" }, "sdk", "recv", 1100);
  expect(Object.values(h.state.tasks).map((t) => t.status)).toEqual(["running", "unknown"]);
  expect(h.deadline()).not.toBe(1100);
});
test("unbound child work keeps a finished root open until identity and completion arrive", () => {
  const h = harness();
  h.init();
  paragraph(h, "first");
  h.result();
  expect(h.state.status.state).not.toBe("done");
  register(h);
  h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
  expect(h.state.status.state).toBe("done");
});
for (const decision of ["pending", "deny"])
  test(`binding buffered tool text preserves its newer ${decision} permission`, () => {
    const h = harness();
    h.init();
    h.send({
      type: "assistant",
      parent_tool_use_id: "launch",
      message: {
        id: "read",
        content: [{ type: "tool_use", id: "read:C", name: "Read", input: { file_path: "file" } }],
      },
    });
    permission(h);
    if (decision === "deny")
      h.send(
        { requestId: "C", result: { behavior: "deny", message: "No" } },
        "can_use_tool",
        "send",
      );
    register(h);
    expect(
      h.items().find((i) => i.type === "tool_call" && i.call.kind === "file.read"),
    ).toMatchObject({
      complete: decision === "deny",
      call: { status: decision === "deny" ? "declined" : "awaiting_approval" },
    });
  });
test("late tool history enriches a terminal child without making it live", () => {
  const h = harness();
  h.init();
  register(h);
  h.system("task_updated", { task_id: "C", patch: { status: "completed" } });
  h.send({
    type: "assistant",
    parent_tool_use_id: "launch",
    message: {
      id: "late-tool",
      content: [{ type: "tool_use", id: "old-read", name: "Read", input: { file_path: "old" } }],
    },
  });
  h.result();
  expect(h.state.status.state).toBe("done");
  expect(
    h.items().find((i) => i.type === "tool_call" && i.call.kind === "file.read"),
  ).toMatchObject({ complete: true, call: { detail: { kind: "file.read", path: "old" } } });
});

test.each([
  { type: "text", text: "child text" },
  { type: "thinking", thinking: "child reasoning" },
  { type: "future_block", payload: "child metadata" },
])("deferred child $type raw payload survives once before and after identity binding", (block) => {
  const h = harness();
  h.init();
  h.send({
    type: "assistant",
    parent_tool_use_id: "launch",
    marker: "deferred",
    message: { id: "raw-child", content: [block] },
  });
  const payloads = () =>
    h
      .rawPayloads()
      .filter(
        (payload) =>
          "data" in payload && JSON.stringify(payload.data)?.includes('"marker":"deferred"'),
      );
  expect(payloads()).toHaveLength(1);
  register(h);
  expect(payloads()).toHaveLength(1);
  expect(h.rawPayloads()).toContainEqual(
    expect.objectContaining({
      data: {
        type: "system",
        subtype: "task_started",
        task_id: "C",
        tool_use_id: "launch",
        task_type: "local_agent",
      },
    }),
  );
  if (block.type === "text") {
    expect(h.items().find((item) => item.type === "message")).toMatchObject({
      parts: [{ type: "text", text: "child text" }],
    });
  } else if (block.type === "thinking") {
    expect(h.items().find((item) => item.type === "reasoning")).toMatchObject({
      text: "child reasoning",
    });
  }
  expect(h.items().filter((item) => item.type === "notice")).toEqual([]);
});
