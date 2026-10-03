import { apply } from "@ace/core";
import { expect, test } from "vitest";
import { createTranslator } from "./index.ts";
import { harness } from "./translator.test-helper.ts";

const launch = (h: ReturnType<typeof harness>) => {
  h.init();
  h.tool("spawn", "Agent", { prompt: "work" });
};
const register = (h: ReturnType<typeof harness>) =>
  h.system("task_started", {
    task_id: "child",
    task_type: "local_agent",
    tool_use_id: "spawn",
  });
const paragraph = (h: ReturnType<typeof harness>, text: string, uuid: string) =>
  h.send({
    type: "assistant",
    uuid,
    parent_tool_use_id: "spawn",
    message: { id: "child-message", content: [{ type: "text", text }] },
  });

test("denying an Agent launch leaves no executing child", () => {
  const h = harness();
  launch(h);
  h.send({
    type: "user",
    tool_result_meta: [{ id: "spawn", non_execution_kind: "permission-rule" }],
    message: {
      content: [{ type: "tool_result", tool_use_id: "spawn", is_error: true, content: "Denied" }],
    },
  });
  h.result();
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.runs)).toHaveLength(1);
});
test("a spawn followed by a native permission and registration executes one child", () => {
  const h = harness();
  launch(h);
  h.send(
    {
      toolName: "Read",
      input: { file_path: "file" },
      options: {
        requestId: "r",
        toolUseID: "read",
        agentID: "child",
      },
    },
    "can_use_tool",
  );
  register(h);
  h.send({ requestId: "r", result: { behavior: "allow" } }, "can_use_tool", "send");
  h.system("task_updated", { task_id: "child", patch: { status: "completed" } });
  h.result();
  expect(Object.values(h.state.agents)).toHaveLength(2);
  expect(Object.values(h.state.runs)).toHaveLength(2);
  expect(h.state.status.state).toBe("done");
});
test("late child transcript enrichment preserves its terminal run", () => {
  const h = harness();
  launch(h);
  register(h);
  h.system("task_updated", { task_id: "child", patch: { status: "completed" } });
  paragraph(h, "late final paragraph", "late");
  h.result();
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.runs)).toHaveLength(2);
  expect(h.items().filter((i) => i.type === "message")).toHaveLength(1);
});
test("native queue draining preserves two inputs held by the engine", () => {
  const h = harness();
  h.init();
  h.result({ queued_turn_count: 1 });
  apply(h.state, { type: "queue.changed", count: 2 }, { now: 3, ids: { next: (k) => k } });
  h.init();
  h.result({ queued_turn_count: 0 });
  expect(h.state.status).toMatchObject({ state: "waiting", on: "queue" });
  expect(h.state.queueCount).toBe(2);
  apply(h.state, { type: "queue.changed", count: 0 }, { now: 5, ids: { next: (k) => k } });
  expect(h.state.status.state).toBe("done");
});
test("separate child paragraphs with one message id survive retransmission", () => {
  const h = harness();
  launch(h);
  register(h);
  paragraph(h, "first paragraph", "block-one");
  paragraph(h, "second paragraph", "block-two");
  paragraph(h, "first paragraph", "block-one");
  expect(
    h
      .items()
      .filter((i) => i.type === "message")
      .map((i) => i.parts),
  ).toEqual([
    [{ type: "text", text: "first paragraph" }],
    [{ type: "text", text: "second paragraph" }],
  ]);
});
for (const ambient of [false, true])
  test(`${ambient ? "ambient" : "blocking"} missing task edge schedules and expires on a frame`, () => {
    const h = harness();
    h.init();
    h.system("background_tasks_changed", {
      tasks: [{ task_id: "shell", task_type: "local_bash", ambient }],
    });
    h.result();
    h.send({ type: "system", subtype: "background_tasks_changed", tasks: [] }, "sdk", "recv", 100);
    expect(h.deadline()).toBe(1100);
    h.send({ type: "keep_alive" }, "sdk", "recv", 1100);
    expect(Object.values(h.state.tasks)[0]?.status).toBe("unknown");
  });

test("root usage preserves provider input, output and cache counts", () => {
  const h = harness();
  h.init();
  h.result({
    usage: { input_tokens: 31, output_tokens: 17, cache_read_input_tokens: 9 },
    total_cost_usd: 0.04,
  });
  const updates = h.events.filter((e) => e.type === "usage.updated");
  expect(updates.find((e) => e.usageScope === "agent")).toMatchObject({
    inputTokens: 40,
    outputTokens: 17,
    cachedInputTokens: 9,
    counterMode: "incremental",
  });
  expect(updates.find((e) => e.usageScope === "agent")).not.toHaveProperty("costUsd");
  expect(updates.find((e) => e.usageScope === "provider_session")).toMatchObject({ costUsd: 0.04 });
});
test("child assistant usage refines a message without counting retransmissions twice", () => {
  const h = harness();
  launch(h);
  register(h);
  const usage = (output_tokens: number) =>
    h.send({
      type: "assistant",
      parent_tool_use_id: "spawn",
      message: {
        id: "child-message",
        content: [{ type: "text", text: "answer" }],
        usage: { input_tokens: 11, output_tokens, cache_read_input_tokens: 3 },
      },
    });
  usage(4);
  usage(7);
  usage(7);
  const updates = h.events.filter((e) => e.type === "usage.updated");
  expect(updates.at(-1)).toMatchObject({ inputTokens: 14, outputTokens: 7, cachedInputTokens: 3 });
  expect(updates.every((e) => e.agentId !== h.state.agents["root"]?.agent.id)).toBe(true);
});
test("an interrupted plan permission records cancellation", () => {
  const h = harness();
  h.init();
  h.send(
    {
      toolName: "ExitPlanMode",
      input: { plan: "plan" },
      options: { requestId: "plan", toolUseID: "review" },
    },
    "can_use_tool",
  );
  h.send(
    { requestId: "plan", result: { behavior: "deny", message: "Cancelled", interrupt: true } },
    "can_use_tool",
    "send",
  );
  expect(Object.values(h.state.interactions)[0]?.resolution).toMatchObject({
    kind: "plan_review",
    decision: "cancel",
  });
});

test("identical child paragraphs with distinct native UUIDs remain separate blocks", () => {
  const h = harness();
  launch(h);
  register(h);
  paragraph(h, "same words", "first");
  paragraph(h, "same words", "second");
  paragraph(h, "same words", "second");
  expect(h.items().filter((i) => i.type === "message")).toHaveLength(2);
});
test("a child terminal finalizes partial text without starting another run", () => {
  const h = harness();
  launch(h);
  register(h);
  h.send({
    type: "stream_event",
    parent_tool_use_id: "spawn",
    event: { type: "message_start", message: { id: "partial-child" } },
  });
  h.send({
    type: "stream_event",
    parent_tool_use_id: "spawn",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "unfinished" },
    },
  });
  h.system("task_updated", { task_id: "child", patch: { status: "completed" } });
  h.result();
  expect(h.items().find((i) => i.type === "message")).toMatchObject({
    complete: true,
    parts: [{ type: "text", text: "unfinished" }],
  });
  expect(h.state.status.state).toBe("done");
});
test("subsequent raw additions survive once without replaying earlier payloads", () => {
  const translator = createTranslator({ rootKey: "root" });
  const payloads: unknown[] = [];
  for (let seq = 0; seq < 100; seq++) {
    const facts = translator.translate(
      {
        seq,
        t: seq,
        channel: "sdk",
        dir: "recv",
        data: {
          type: "assistant",
          message: { id: "m", content: [{ type: "text", text: "answer" }] },
          extra: seq,
        },
      },
      seq,
    );
    for (const fact of facts)
      if (
        fact.type === "item.upsert" &&
        (fact.draft.type === "notice" || fact.draft.type === "message")
      )
        payloads.push(...(fact.draft.raw ?? []).flatMap((r) => ("data" in r ? [r.data] : [])));
  }
  expect(payloads).toHaveLength(100);
  for (let seq = 0; seq < 100; seq++) expect(payloads[seq]).toMatchObject({ extra: seq });
});
