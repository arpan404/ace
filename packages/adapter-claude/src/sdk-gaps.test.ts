import { expect, test } from "vitest";
import { harness } from "./translator.test-helper.ts";

const usage = (inputTokens: number, costUSD: number) => ({
  inputTokens,
  outputTokens: 7,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 2,
  costUSD,
  futureModelMetric: "kept",
});

test("permission destinations and native decline defaults remain visible without persistent grants when suppressed", () => {
  for (const suppressAlwaysAllowRule of [false, true]) {
    const h = harness();
    h.init();
    const suggestions = [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
      { type: "addDirectories", directories: ["/tmp/tools"], destination: "projectSettings" },
    ];
    h.send(
      {
        toolName: "Read",
        input: {},
        options: {
          requestId: "ask",
          toolUseID: "read",
          title: "Claude wants to read",
          description: "Read access",
          defaultToNo: true,
          suppressAlwaysAllowRule,
          mcpServer: { name: "project-tools", source: "project", extension: 42 },
          suggestions,
        },
      },
      "can_use_tool",
    );
    const request = Object.values(h.state.interactions)[0]?.request;
    expect(request).toMatchObject({
      title: "Claude wants to read",
      description: "Read access",
      defaultToNo: true,
      suppressAlwaysAllowRule,
      mcpServer: { source: "project", extension: 42 },
      permissionUpdates: suggestions,
    });
    if (request?.kind !== "approval") throw new Error("Missing approval");
    expect(request.options.map((o) => o.id)).toEqual(
      suppressAlwaysAllowRule ? ["allow_once", "deny"] : ["allow_once", "deny", "allow_updates"],
    );
    if (!suppressAlwaysAllowRule)
      expect(request.options.at(-1)?.label).toBe(
        "Allow and update this session and project settings",
      );
  }
});

test("a child keeps producing canonical progress while an elicitation waits beyond a minute", () => {
  const h = harness();
  h.init();
  h.system("task_started", { task_id: "child", tool_use_id: "spawn", task_type: "local_agent" });
  h.send(
    {
      requestId: "ask",
      request: {
        kind: "elicitation",
        server: "tools",
        message: "Choose",
        mode: "form",
        schema: { type: "object" },
      },
    },
    "elicitation",
  );
  h.result();
  h.send(
    {
      type: "assistant",
      parent_tool_use_id: "spawn",
      message: { id: "child-late", content: [{ type: "text", text: "Still working" }] },
    },
    "sdk",
    "recv",
    120_000,
  );
  expect(Object.values(h.state.interactions)[0]?.state).toBe("pending");
  expect(h.items()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        parts: [{ type: "text", text: "Still working" }],
      }),
    ]),
  );
  expect(h.state.status.state).not.toBe("done");
  h.send({ requestId: "ask", state: "expired" }, "interaction_lifecycle");
  expect(Object.values(h.state.interactions)[0]?.state).toBe("expired");
});

test("duplicate root results cannot finish a later turn or add another main-loop usage sample", () => {
  const h = harness();
  h.init();
  const result = {
    uuid: "r1",
    result_index: 0,
    usage: { input_tokens: 10, output_tokens: 4 },
    modelUsage: { sonnet: usage(40, 0.3) },
    total_cost_usd: 0.3,
  };
  h.result(result);
  h.send(
    { type: "user", uuid: "send2", message: { content: [{ type: "text", text: "next" }] } },
    "sdk",
    "send",
  );
  h.result(result);
  expect(h.state.status.state).toBe("working");
  expect(
    h.events.filter((e) => e.type === "usage.updated" && e.usageScope === "agent"),
  ).toHaveLength(1);
  h.result({
    uuid: "r2",
    result_index: 1,
    usage: { input_tokens: 5, output_tokens: 2 },
    modelUsage: { sonnet: usage(50, 0.4) },
    total_cost_usd: 0.4,
  });
  const updates = h.events.filter((e) => e.type === "usage.updated");
  expect(updates.filter((e) => e.usageScope === "agent").map((e) => e.inputTokens)).toEqual([
    10, 5,
  ]);
  expect(
    updates.filter((e) => e.usageScope === "agent").every((e) => e.costUsd === undefined),
  ).toBe(true);
  expect(updates.findLast((e) => e.usageScope === "model_session")).toMatchObject({
    inputTokens: 55,
    costUsd: 0.4,
  });
});

test("clear starts a separate cumulative estimate while startup failures preserve prior accounting", () => {
  const h = harness();
  h.init();
  h.result({ uuid: "first", total_cost_usd: 2, modelUsage: { opus: usage(100, 2) } });
  h.result({
    uuid: "startup",
    startup_failure_reason: "configuration_error",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  });
  const before = h.events.filter((e) => e.type === "usage.updated");
  expect(before).toHaveLength(2);
  h.send({ type: "conversation_reset", new_conversation_id: "cleared", future: 42 });
  h.result({ uuid: "new", total_cost_usd: 0.1, modelUsage: { opus: usage(4, 0.1) } });
  const costs = h.events
    .filter((e) => e.type === "usage.updated")
    .filter((e) => e.usageScope === "provider_session");
  expect(costs.map((e) => e.costUsd)).toEqual([2, 0.1]);
  expect(costs[0]?.counterKey).not.toBe(costs[1]?.counterKey);
});

test("an allowed rate window clears only its own block and leaves later network retries intact", () => {
  const h = harness();
  h.init();
  const rate = (status: string, rateLimitType: string) =>
    h.send({
      type: "rate_limit_event",
      rate_limit_info: {
        status,
        rateLimitType,
        resetsAt: 1900000000,
        utilization: 1,
        future: "retained",
      },
    });
  rate("rejected", "five_hour");
  rate("rejected", "seven_day");
  h.result();
  rate("allowed", "five_hour");
  expect(h.state.agents["root"]?.agent.status).toMatchObject({
    state: "blocked",
    on: "rate_limit",
  });
  h.system("api_retry", { error: "connection lost", error_status: null });
  rate("allowed", "seven_day");
  expect(h.state.agents["root"]?.agent.status).toMatchObject({ state: "blocked", on: "network" });
  expect(
    h
      .items()
      .some(
        (item) =>
          item.type === "notice" &&
          item.raw.some(
            (r) => "data" in r && JSON.stringify(r.data).includes('"future":"retained"'),
          ),
      ),
  ).toBe(true);
});

test("interrupt survivors hold a finished thread until their correlated result is observed", () => {
  const h = harness();
  h.system("init", { session_id: "s", capabilities: ["interrupt_receipt_v1"] });
  h.send(
    { type: "user", uuid: "survivor", message: { content: [{ type: "text", text: "next" }] } },
    "sdk",
    "send",
  );
  h.send(
    { type: "control_request", request_id: "interrupt", request: { subtype: "interrupt" } },
    "wire",
    "send",
  );
  h.send(
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "interrupt",
        response: { still_queued: ["survivor", "unknown-internal"], future: 42 },
      },
    },
    "wire",
  );
  h.result({ uuid: "interrupted", terminal_reason: "aborted_streaming" });
  expect(h.state.queueCount).toBe(1);
  expect(h.state.status.state).not.toBe("done");
  h.result({ uuid: "finished", user_message_uuids: ["survivor"], queued_turn_count: 0 });
  expect(h.state.queueCount).toBe(0);
  expect(h.state.status.state).toBe("done");
});

test("older Claude interrupts without a receipt preserve independent background work", () => {
  const h = harness();
  h.init();
  h.system("task_started", { task_id: "shell", task_type: "local_bash", is_backgrounded: true });
  h.send(
    {
      type: "control_response",
      response: { subtype: "success", request_id: "interrupt", response: {} },
    },
    "wire",
  );
  h.result({ terminal_reason: "aborted_streaming" });
  expect(h.state.status.state).not.toBe("done");
  h.send({ type: "process.exited", deliberate: false }, "lifecycle", "note");
  expect(Object.values(h.state.tasks).every((task) => task.status !== "running")).toBe(true);
});

test("partial tool JSON stays raw until the provider supplies a completed tool input", () => {
  const h = harness();
  h.init();
  for (const event of [
    { type: "message_start", message: { id: "partial-tool" } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "read", name: "Read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"file_path":"incomplete' },
    },
  ])
    h.send({ type: "stream_event", event });
  expect(h.items().filter((item) => item.type === "tool_call")).toEqual([]);
  h.send({
    type: "assistant",
    message: {
      id: "partial-tool",
      content: [
        { type: "tool_use", id: "read", name: "Read", input: { file_path: "complete.ts" } },
      ],
    },
  });
  expect(h.items().find((item) => item.type === "tool_call")).toMatchObject({
    call: { detail: { kind: "file.read", path: "complete.ts" } },
  });
});
