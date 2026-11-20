import { it, expect } from "vitest";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { harness, required, end } from "./test-helper.ts";
import { antigravityQuirks, createAcpTranslator } from "./index.ts";

function shell(h: ReturnType<typeof harness>, status: "pending" | "in_progress") {
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    title: "Run tests",
    rawInput: { command: "bun run test" },
    status,
  });
}
function askPermission(h: ReturnType<typeof harness>) {
  h.frame("recv", {
    id: 50,
    method: "session/request_permission",
    params: {
      sessionId: "root-session",
      toolCall: { toolCallId: "shell" },
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Deny", kind: "reject_once" },
      ],
    },
  });
}
const placeholder = (h: ReturnType<typeof harness>) =>
  required(Object.values(h.state.agents).find((a) => a.agent.fidelity === "placeholder")).agent;

it("a cancelled approval settles its shell as cancelled and holds no background task", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  shell(h, "pending");
  askPermission(h);
  h.frame("send", { id: 50, result: { outcome: { outcome: "cancelled" } } });
  expect(required(h.tools()[0]).call.status).toBe("cancelled");
  end(h);
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.tasks)).toEqual([]);
});

it("a shell still awaiting approval when an Antigravity prompt ends never becomes a background task", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  shell(h, "pending");
  askPermission(h);
  end(h);
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.tasks)).toEqual([]);
  expect(required(h.tools()[0]).call.status).toBe("cancelled");
});

it("an allowed Antigravity shell still running at prompt end stays a background task", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  shell(h, "pending");
  askPermission(h);
  h.frame("send", { id: 50, result: { outcome: { outcome: "selected", optionId: "once" } } });
  end(h);
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
});

it("an error reply to the prompt ends a running Antigravity shell instead of holding prompts", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  shell(h, "in_progress");
  h.frame("recv", { id: 2, error: { code: -32603, message: "Internal error" } });
  expect(h.state.status.state).not.toBe("working");
  expect(h.state.status).not.toMatchObject({ state: "waiting" });
  expect(Object.values(h.state.tasks)).toEqual([]);
  expect(required(h.tools()[0]).call.status).toBe("cancelled");
});

function startSubagent(h: ReturnType<typeof harness>) {
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "spawn",
    title: "start_subagent",
    kind: "other",
    status: "in_progress",
  });
}

it("an Antigravity placeholder subagent stops working when its parent's turn ends", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  startSubagent(h);
  expect(placeholder(h).status.state).toBe("working");
  end(h);
  expect(placeholder(h).status.state).not.toBe("working");
  expect(h.state.status.state).toBe("done");
});

it("cancelling an Antigravity turn interrupts its placeholder subagent at once, with no grace wait", () => {
  const h = harness(antigravityQuirks);
  h.ready();
  startSubagent(h);
  end(h, "cancelled");
  expect(placeholder(h).status.state).not.toBe("working");
  expect(h.state.status.state).toBe("done");
  expect(h.deadline()).toBeUndefined();
});

// The shared harness treats any warning notice as a failure, so these drive the translator directly.
function driver() {
  const threadId = ThreadId.parse("cut-off");
  const translator = createAcpTranslator(
    { threadId, rootKey: "root", identity: { generation: "test", cursor: 0 } },
    antigravityQuirks,
  );
  const state = createThreadState({
    threadId,
    config: { provider: "antigravity", silenceMs: 90_000 },
  });
  let seq = 0;
  let ids = 0;
  const frame = (dir: Frame["dir"], data: unknown) => {
    const t = ++seq;
    for (const fact of translator.translate({ seq: t, t, dir, channel: "stdio", data }, t))
      apply(state, fact, { now: t, ids: { next: () => `id-${++ids}` } });
  };
  frame("send", { id: 1, method: "session/new", params: { cwd: "/workspace" } });
  frame("recv", { id: 1, result: { sessionId: "root-session" } });
  frame("send", {
    id: 2,
    method: "session/prompt",
    params: { sessionId: "root-session", prompt: [{ type: "text", text: "Write it all" }] },
  });
  return { state, frame };
}
for (const [stopReason, text] of [
  ["max_tokens", "output token limit"],
  ["max_turn_requests", "limit of model requests"],
] as const)
  it(`a turn that stops on ${stopReason} ends but tells the person the agent was cut off`, () => {
    const h = driver();
    h.frame("recv", { id: 2, result: { stopReason } });
    expect(h.state.status.state).toBe("done");
    const warnings = Object.values(h.state.items).filter(
      (item) => item.type === "notice" && item.level === "warning",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ text: expect.stringContaining(text) });
  });

it("a turn that ends normally carries no cut-off warning", () => {
  const h = driver();
  h.frame("recv", { id: 2, result: { stopReason: "end_turn" } });
  expect(
    Object.values(h.state.items).filter((i) => i.type === "notice" && i.level === "warning"),
  ).toEqual([]);
});
