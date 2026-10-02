import { expect, test } from "vitest";
import { setup, shell } from "./translator.test-helper.ts";
import { obj } from "./native.ts";
test("command output without its start frame still holds completion after the turn", () => {
  const h = setup();
  h.start();
  h.recv("item/commandExecution/outputDelta", {
    threadId: "native",
    turnId: "turn",
    itemId: "exec",
    delta: "running",
  });
  h.end();
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  h.item({ ...shell, status: "completed", aggregatedOutput: "running" }, true);
  expect(h.state.status.state).toBe("done");
});
test("unknown delta methods remain raw instead of corrupting an existing tool", () => {
  const h = setup();
  h.start();
  h.item({ id: "future", type: "futureTool", extra: 1 });
  h.recv("item/futureTool/delta", { threadId: "native", itemId: "future", delta: "untyped" });
  expect(
    Object.values(h.state.items).some(
      (i) => i.type === "notice" && i.raw.some((r) => r.type === "item/futureTool/delta"),
    ),
  ).toBe(true);
});
test("completion preserves the original tool name and input alongside changed result fields", () => {
  const h = setup();
  h.start();
  h.item({
    type: "dynamicToolCall",
    id: "dynamic",
    tool: "future_name",
    arguments: { original: true },
    vendorField: 9,
  });
  h.item(
    {
      type: "dynamicToolCall",
      id: "dynamic",
      tool: "future_name",
      arguments: null,
      contentItems: ["result"],
    },
    true,
  );
  const tool = Object.values(h.state.items).find(
    (i) => i.type === "tool_call" && i.call.raw.some((r) => obj(r.data)["vendorField"] === 9),
  );
  expect(tool?.type === "tool_call" && tool.call.raw[0]).toMatchObject({
    name: "future_name",
    data: { arguments: { original: true } },
  });
});
test("replayed turn completion does not reopen an already resolved plan review", () => {
  const h = setup();
  h.recv("thread/settings/updated", { threadId: "native", collaborationMode: { mode: "plan" } });
  h.start();
  h.item({ id: "p", type: "plan", text: "Plan" }, true);
  h.end();
  h.feed({
    seq: 50,
    t: 100,
    dir: "note",
    channel: "adapter",
    data: { event: "interaction-resolved", interaction: "plan:turn" },
  });
  h.end();
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.interactions).filter((i) => i.state === "pending")).toHaveLength(0);
});

test("legacy spawn items link and retain the child's work", () => {
  const h = setup();
  h.start();
  h.item(
    {
      id: "legacy-spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      receiverThreadIds: ["child"],
      status: "completed",
      prompt: "Read files",
    },
    true,
  );
  h.start("child", "child-turn");
  h.end();
  expect(h.state.status.state).not.toBe("done");
  h.end("completed", "child", "child-turn");
  expect(h.state.status.state).toBe("done");
});
test("reasoning deltas stream into the existing reasoning item", () => {
  const h = setup();
  h.start();
  h.item({ id: "reason", type: "reasoning", summary: [], content: [] });
  h.recv("item/reasoning/summaryTextDelta", {
    threadId: "native",
    itemId: "reason",
    delta: "Thinking",
  });
  expect(
    Object.values(h.state.items).some((i) => i.type === "reasoning" && i.text === "Thinking"),
  ).toBe(true);
});
test("a late old boundary preserves the current turn's pending approval", () => {
  const h = setup();
  h.start();
  h.end();
  h.start("native", "new-turn");
  h.recv(
    "item/commandExecution/requestApproval",
    {
      threadId: "native",
      turnId: "new-turn",
      itemId: "new-command",
      availableDecisions: ["accept"],
    },
    8,
  );
  h.end();
  expect(h.state.status.state).toBe("needs_you");
});

test("a buffered child end without its start does not create an immortal subagent task", () => {
  const h = setup();
  h.start();
  h.end("completed", "child", "child-turn");
  h.item(
    {
      id: "spawn",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/child",
    },
    true,
  );
  h.end();
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.tasks).some((t) => t.status === "running")).toBe(false);
});

test("an unresolved unknown child holds completion even after its liveness deadline", () => {
  const h = setup();
  h.start();
  h.start("unknown-child", "child-turn");
  h.end();
  h.feedFact({ type: "tick" }, 100_000);
  expect(h.state.status.state).not.toBe("done");
});
