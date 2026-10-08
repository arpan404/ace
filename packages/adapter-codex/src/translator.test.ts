import { expect, test } from "vitest";
import { setup, shell } from "./translator.test-helper.ts";
import { requestKey } from "./native.ts";
test("a late child registration retains its earlier turn and transcript", () => {
  const h = setup();
  h.start();
  h.start("child", "child-turn");
  h.item({ id: "child-text", type: "agentMessage", text: "buffered" }, true, "child", "child-turn");
  h.end();
  expect(h.state.status.state).not.toBe("done");
  h.item(
    {
      id: "spawn",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/reader",
    },
    true,
  );
  const view = h.events.find(
    (e) =>
      e.type === "item.created" &&
      e.item.type === "message" &&
      e.item.parts.some((p) => p.type === "text" && p.text === "buffered"),
  );
  expect(view).toBeDefined();
  expect(
    Object.values(h.state.runs).some((r) => r.nativeId === "child-turn" && r.state === "active"),
  ).toBe(true);
  h.end("completed", "child", "child-turn");
  expect(h.state.status.state).toBe("done");
});
test("interrupt keeps a surviving command waiting until its stale-turn completion", () => {
  const h = setup();
  h.start();
  h.item(shell);
  h.end("interrupted");
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  h.recv("item/commandExecution/outputDelta", {
    threadId: "native",
    turnId: "turn",
    itemId: "exec",
    delta: "still running\n",
  });
  expect(h.state.status.state).toBe("waiting");
  h.item(
    { ...shell, status: "completed", aggregatedOutput: "still running\nfinished\n", exitCode: 0 },
    true,
  );
  expect(h.state.status.state).toBe("done");
  const call = Object.values(h.state.items).find(
    (i) => i.type === "tool_call" && i.call.kind === "shell",
  );
  expect(
    call?.type === "tool_call" &&
      call.call.detail.kind === "shell" &&
      call.call.detail.output?.tail,
  ).toBe("still running\nfinished\n");
  expect(Object.values(h.state.tasks).map((t) => t.status)).toEqual(["completed"]);
});
test("a stale completion leaves a newer turn active", () => {
  const h = setup();
  h.start();
  h.item(shell);
  h.end();
  h.start("native", "next");
  h.item({ ...shell, status: "completed" }, true);
  expect(h.state.status.state).toBe("working");
  h.end("completed", "native", "next");
  expect(h.state.status.state).toBe("done");
});
test("async final-answer questions stay non-blocking and become actionable after turn end", () => {
  const h = setup();
  h.start();
  h.item(
    {
      id: "question",
      type: "agentMessage",
      delivery: "async",
      phase: "final_answer",
      text: "",
      questions: [{ title: "Indentation?", options: ["Tabs", "Spaces"] }],
    },
    true,
  );
  expect(h.state.status.state).toBe("working");
  const question = Object.values(h.state.interactions)[0];
  if (!question) throw new Error("Question was not emitted");
  expect(question.blocking).toBe(false);
  expect(question.request).toMatchObject({
    kind: "question",
    questions: [
      {
        id: "q0",
        text: "Indentation?",
        options: [
          { id: "Tabs", label: "Tabs" },
          { id: "Spaces", label: "Spaces" },
        ],
        allowOther: true,
      },
    ],
  });
  h.end();
  expect(h.state.status.state).toBe("needs_you");
  h.send("turn/start", { threadId: "native", input: [{ type: "text", text: "Tabs" }] });
  h.feed({
    seq: 99,
    t: 100,
    dir: "recv",
    channel: "stdio",
    data: { id: 90, result: { turn: { id: "answer" } } },
  });
  h.feed({
    seq: 100,
    t: 101,
    dir: "note",
    channel: "stdio",
    data: { event: "interaction-resolved", interaction: "async:question" },
  });
  expect(Object.values(h.state.interactions)[0]?.state).toBe("resolved");
});
test("a failed steer does not silently resolve an async question", () => {
  const h = setup();
  h.start();
  h.item(
    {
      id: "question",
      type: "agentMessage",
      delivery: "async",
      questions: [{ title: "Continue?", options: [] }],
    },
    true,
  );
  h.send("turn/steer", { threadId: "native" });
  h.feed({
    seq: 99,
    t: 100,
    dir: "recv",
    channel: "stdio",
    data: { id: 90, error: { message: "stale turn" } },
  });
  h.end();
  expect(h.state.status.state).toBe("needs_you");
});
test("a question without a backing item emits an ask-user tool and resolves once confirmed", () => {
  const h = setup();
  h.start();
  h.recv(
    "item/tool/requestUserInput",
    {
      threadId: "native",
      turnId: "turn",
      itemId: "missing",
      questions: [
        {
          id: "q",
          question: "Continue?",
          options: [{ label: "Yes", description: "proceed" }],
          isOther: true,
        },
      ],
    },
    7,
  );
  expect(h.state.status.state).toBe("needs_you");
  const tool = Object.values(h.state.items).find(
    (i) => i.type === "tool_call" && i.call.kind === "ask_user",
  );
  expect(Object.values(h.state.interactions)[0]?.toolCallId).toBe(tool?.id);
  expect(tool?.type === "tool_call" && tool.call.raw).toMatchObject([
    {
      type: "item/tool/requestUserInput",
      data: { itemId: "missing", questions: [{ id: "q", question: "Continue?" }] },
    },
  ]);
  h.recv("serverRequest/resolved", { threadId: "native", requestId: 7 });
  h.end();
  expect(h.state.status.state).toBe("done");
  expect(h.state.interactions[requestKey(7)]?.state).toBe("resolved");
});
test("parallel approvals remain blocked until both requests resolve", () => {
  const h = setup();
  h.start();
  for (const id of [1, 2])
    h.recv(
      "item/commandExecution/requestApproval",
      {
        threadId: "native",
        itemId: `exec${id}`,
        availableDecisions: [
          "accept",
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["cat"] } },
          "cancel",
        ],
      },
      id,
    );
  expect(Object.values(h.state.interactions)[0]?.request).toMatchObject({
    options: [
      { id: "accept", kind: "allow_once" },
      { id: "acceptWithExecpolicyAmendment", kind: "allow_always" },
      { id: "cancel", kind: "cancel" },
    ],
  });
  h.recv("serverRequest/resolved", { threadId: "native", requestId: 2 });
  expect(h.state.status.state).toBe("needs_you");
  h.recv("serverRequest/resolved", { threadId: "native", requestId: 1 });
  expect(h.state.status.state).toBe("working");
});
test("a completed plan opens review and keeps the thread from finishing", () => {
  const h = setup();
  h.recv("thread/settings/updated", { threadId: "native", collaborationMode: { mode: "plan" } });
  h.start();
  h.item({ id: "plan-item", type: "plan", text: "" });
  h.recv("item/plan/delta", { threadId: "native", itemId: "plan-item", delta: "# Proposal" });
  const plan = Object.values(h.state.items).find(
    (i) => i.type === "tool_call" && i.call.kind === "plan",
  );
  expect(plan?.type === "tool_call" && plan.call.detail).toMatchObject({ markdown: "" });
  expect(
    Object.values(h.state.items).some((i) => i.type === "notice" && i.text === "# Proposal"),
  ).toBe(true);
  h.item({ id: "plan-item", type: "plan", text: "# Proposal" }, true);
  h.end();
  expect(h.state.status.state).toBe("needs_you");
  expect(Object.values(h.state.interactions)[0]?.request).toEqual({
    kind: "plan_review",
    markdown: "# Proposal",
  });
});
test("provider usage-limit text retains a limit after nominal turn completion", () => {
  const h = setup();
  h.start();
  h.item(
    { type: "agentMessage", id: "error", text: "You've hit your usage limit. Try again later." },
    true,
  );
  h.end();
  expect(h.state.status).toEqual({ state: "limited" });
  expect(Object.values(h.state.runs)).toContainEqual(expect.objectContaining({ state: "failed" }));
});
test("ordinary prose mentioning an error does not make the turn fail", () => {
  const h = setup();
  h.start();
  h.item(
    {
      type: "agentMessage",
      id: "message",
      text: "The test covers authentication failed and rate limit reached.",
    },
    true,
  );
  h.end();
  expect(h.state.status.state).toBe("done");
});
test("generic provider activity cannot clear a usage limit", () => {
  const h = setup();
  h.start();
  h.recv("error", {
    threadId: "native",
    willRetry: true,
    error: { codexErrorInfo: "rateLimitExceeded", message: "busy" },
  });
  expect(h.state.status).toEqual({ state: "limited" });
  h.item({ type: "agentMessage", id: "message", text: "retry worked" }, true);
  expect(h.state.status).toEqual({ state: "limited" });
  h.feedFact({ type: "limit.cleared", agent: "root" }, 100);
  expect(h.state.status.state).toBe("working");
});
test("unknown items, frames and malformed data survive as raw payloads", () => {
  const h = setup();
  h.start();
  const future = { id: "future", type: "futureTool", arguments: { nested: true }, vendorField: 3 };
  h.item(future, true);
  h.recv("future/event", { threadId: "native", newField: [1, 2] });
  for (const data of [
    null,
    [],
    "bad",
    { params: 42 },
    { method: "item/started", params: { threadId: "native", item: null } },
  ])
    expect(() => h.feed({ seq: 98, t: 100, dir: "recv", channel: "stdio", data })).not.toThrow();
  expect(
    Object.values(h.state.items).some(
      (i) =>
        i.type === "tool_call" &&
        i.call.raw.some(
          (r) => ("data" in r ? JSON.stringify(r.data) : undefined) === JSON.stringify(future),
        ),
    ),
  ).toBe(true);
  expect(h.diagnostics.some((r) => r.type === "future/event")).toBe(true);
});
test("an unknown approval flag remains blocked even without a recognized request", () => {
  const h = setup();
  h.start();
  h.recv("thread/status/changed", {
    threadId: "native",
    status: { type: "active", activeFlags: ["futureApproval"] },
  });
  for (const fact of h.translator.tick(100)) h.feedFact(fact, 100);
  expect(h.state.status.state).toBe("needs_you");
  h.recv("thread/status/changed", {
    threadId: "native",
    status: { type: "active", activeFlags: [] },
  });
  expect(h.state.status.state).toBe("working");
});
test("process death expires questions and fails surviving work", () => {
  const h = setup();
  h.start();
  h.item(shell);
  h.recv("item/tool/requestUserInput", { threadId: "native", itemId: "q", questions: [] }, 1);
  h.feed({ seq: 99, t: 100, dir: "note", channel: "recorder", data: { event: "process-exit" } });
  expect(h.state.status.state).toBe("failed");
  expect(Object.values(h.state.interactions)[0]?.state).toBe("expired");
});

test("MCP item errors preserve the native error message on the tool row", () => {
  const h = setup();
  h.start();
  h.item(
    {
      id: "ace-error",
      type: "mcpToolCall",
      server: "ace",
      tool: "screen_click",
      arguments: { x: 1, y: 2 },
      status: "failed",
      error: { message: "Text destination changed" },
    },
    true,
  );
  const item = Object.values(h.state.items).find((entry) => entry.type === "tool_call");
  expect(item).toMatchObject({
    complete: true,
    call: { status: "failed", error: "Text destination changed" },
  });
});
