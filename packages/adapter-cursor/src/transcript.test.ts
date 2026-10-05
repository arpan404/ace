import { describe, expect, it } from "vitest";
import { deriveThreadStatus } from "@ace/core";
import { replay, texts } from "./translator-test-support.ts";

describe("Cursor SDK boundary replay", () => {
  it("retains identical messages from separate operations instead of collapsing by equality", () => {
    const r = replay();
    r.frame("delta", { type: "text-delta", text: "same" });
    r.frame("result", { status: "finished" });
    r.frame("send", { input: [] }, { operationId: "operation2" });
    r.frame("delta", { type: "text-delta", text: "same" }, { operationId: "operation2" });
    r.frame("result", { status: "finished" }, { operationId: "operation2" });
    expect(texts(r.state)).toEqual(["same", "same"]);
    expect(Object.values(r.state.runs)).toHaveLength(2);
  });
  it("keeps one ace run across replacement segments and fences a late old result", () => {
    const r = replay();
    r.frame("delta", { type: "text-delta", text: "old" });
    r.frame("cancel", { replacement: true }, { dir: "send" });
    r.frame("result", { status: "cancelled" });
    r.frame("send", { input: [] }, { segment: 1 });
    r.frame("result", { status: "finished" });
    expect(Object.values(r.state.runs)).toHaveLength(1);
    expect(Object.values(r.state.runs)[0]?.state).toBe("active");
    r.frame("delta", { type: "text-delta", text: "replacement" }, { segment: 1 });
    r.frame("result", { status: "finished" }, { segment: 1 });
    expect(texts(r.state)).toEqual(["old", "replacement"]);
    expect(Object.values(r.state.runs)).toHaveLength(1);
    expect(deriveThreadStatus(r.state).state).toBe("done");
  });
  it("retains unknown extensions and surfaces snapshot identity ambiguity without duplicating content", () => {
    const r = replay();
    r.frame("delta", { type: "text-delta", text: "already streamed" });
    r.frame("snapshot", {
      offset: 0,
      revision: "revision1",
      items: [{ uuid: "native-root:0", text: "already streamed" }],
    });
    r.frame("message", { type: "future-message", vendor: { opaque: 7 } });
    expect(texts(r.state)).toEqual(["already streamed"]);
    expect(JSON.stringify(r.diagnostics)).toContain('"opaque":7');
    expect(JSON.stringify(r.state.items)).not.toContain('"opaque":7');
    r.frame("future-envelope", { retained: "future-channel" });
    expect(JSON.stringify(r.diagnostics)).toContain("future-channel");
    expect(JSON.stringify(r.state.items)).not.toContain("future-channel");
    expect(
      Object.values(r.state.items).some(
        (item) => item.type === "notice" && item.text.includes("No uncertain history"),
      ),
    ).toBe(true);
  });
  it("keeps a denied tool failed even when its root run succeeds and opens no fabricated interaction", () => {
    const r = replay();
    r.frame("delta", {
      type: "tool-call-started",
      callId: "denied",
      toolCall: { type: "mcp", args: { server: "ace", tool: "ace_spawn" } },
    });
    r.frame("delta", {
      type: "tool-call-completed",
      callId: "denied",
      toolCall: { type: "mcp", result: { status: "error", error: { message: "Sandbox denied" } } },
    });
    r.frame("result", { status: "finished" });
    expect(
      Object.values(r.state.items)
        .filter((item) => item.type === "tool_call")
        .map((item) => item.call.status),
    ).toEqual(["failed"]);
    expect(Object.values(r.state.interactions)).toHaveLength(0);
  });
});

it("maps SDK camel-case plans, todos and edit diffs without a review prompt", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "plan",
    toolCall: {
      type: "createPlan",
      args: { plan: "Implement validation" },
      result: { status: "success", value: {} },
    },
  });
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "todos",
    toolCall: {
      type: "updateTodos",
      args: { todos: [{ content: "validate", status: "inProgress" }] },
      result: { status: "success", value: {} },
    },
  });
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "edit",
    toolCall: {
      type: "edit",
      args: { path: "src/math.ts" },
      result: { status: "success", value: { diffString: "+new line" } },
      truncated: { result: true },
    },
  });
  const calls = Object.values(r.state.items).filter((item) => item.type === "tool_call");
  expect(calls.map((item) => item.call.detail)).toEqual([
    { kind: "plan", markdown: "Implement validation" },
    { kind: "todo", todos: [{ content: "validate", status: "in_progress" }] },
    { kind: "file.edit", changes: [{ path: "src/math.ts", kind: "update", diff: "+new line" }] },
  ]);
  expect(Object.values(r.state.interactions)).toHaveLength(0);
  expect(
    Object.values(r.state.items).some(
      (item) => item.type === "notice" && item.text.includes("truncated"),
    ),
  ).toBe(true);
});

for (const [code, kind] of [
  ["auth", "auth"],
  ["rate_limit", "quota"],
  ["network", "network"],
] as const) {
  it(`keeps authoritative ${kind} failure truthful without manufacturing a retry`, () => {
    const r = replay();
    r.frame("error", { code, retryable: true, message: "Safe provider failure" });
    expect(Object.values(r.state.runs)[0]).toMatchObject({ state: "failed" });
    expect(r.state.agents.root?.lastError).toMatchObject({ kind });
    expect(r.state.agents.root?.retry).toBeUndefined();
    expect(r.state.agents.root?.agent.status).toMatchObject(
      kind === "quota"
        ? { state: "blocked", on: "rate_limit" }
        : { state: "failed", error: { kind } },
    );
    if (kind === "quota") expect(deriveThreadStatus(r.state)).toEqual({ state: "limited" });
  });
}

it("fences retained tool argument overflow visibly and refuses later transcript growth", () => {
  const r = replay({ maxPendingBytes: 4096 });
  for (const callId of ["first", "overflow"])
    r.frame("delta", {
      type: "tool-call-started",
      callId,
      toolCall: { type: "read", args: { path: "README.md", opaque: "x".repeat(3000) } },
    });
  r.frame("delta", { type: "text-delta", text: "must not be admitted" });
  expect(
    Object.values(r.state.items).some(
      (item) => item.type === "notice" && item.text.includes("budget exceeded"),
    ),
  ).toBe(true);
  expect(texts(r.state)).toEqual([]);
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
});

it("retains the first failed outcome when a duplicate terminal result claims success", () => {
  const r = replay();
  r.frame("result", { status: "error", error: { message: "failure" } });
  r.frame("result", { status: "finished" });
  expect(Object.values(r.state.runs)[0]).toMatchObject({ state: "failed" });
  expect(deriveThreadStatus(r.state).state).toBe("failed");
});

it("records supplied user input once while the SDK repeats its user stream message", () => {
  const r = replay();
  r.frame("message", {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "synthetic input" }] },
  });
  expect(
    Object.values(r.state.items).filter((item) => item.type === "message" && item.role === "user"),
  ).toMatchObject([{ parts: [{ type: "text", text: "synthetic input" }] }]);
});
it("keeps an unrecognized SDK result uncertain instead of claiming completion or failure", () => {
  const r = replay();
  r.frame("result", { status: "future-terminal" });
  expect(Object.values(r.state.runs)[0]).toMatchObject({ state: "active" });
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
  expect(
    Object.values(r.state.items).some(
      (item) => item.type === "notice" && item.text.includes("Unrecognized SDK terminal status"),
    ),
  ).toBe(true);
});

it("settles a late failed tool without splitting replacement text or ending the steered run", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "old-tool",
    toolCall: { type: "mcp", args: { tool: "read" } },
  });
  r.frame("cancel", { replacement: true }, { dir: "send" });
  r.frame("result", { status: "cancelled" });
  r.frame("send", { input: [] }, { segment: 1 });
  r.frame("delta", { type: "text-delta", text: "new " }, { segment: 1 });
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "old-tool",
    toolCall: { type: "mcp", result: { status: "error", error: { message: "denied" } } },
  });
  r.frame("delta", { type: "text-delta", text: "text" }, { segment: 1 });
  expect(texts(r.state)).toEqual(["new text"]);
  expect(
    Object.values(r.state.items)
      .filter((item) => item.type === "tool_call")
      .map((item) => item.call.status),
  ).toEqual(["failed"]);
  expect(Object.values(r.state.runs)).toHaveLength(1);
  expect(Object.values(r.state.runs)[0]?.state).toBe("active");
  expect(Object.values(r.state.tasks).map((task) => task.status)).toEqual(["failed"]);
});

it("settles surviving tool uncertainty only after an authoritative late completion", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "surviving-shell",
    toolCall: { type: "shell", args: { command: "synthetic operation" } },
  });
  r.frame("result", { status: "finished" });
  expect(deriveThreadStatus(r.state)).toEqual({ state: "waiting", on: "background_task" });
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "surviving-shell",
    toolCall: { type: "shell", result: { status: "success", value: { exitCode: 0 } } },
  });
  expect(Object.values(r.state.tasks).map((task) => task.status)).toEqual(["completed"]);
  expect(deriveThreadStatus(r.state).state).toBe("done");
});

it("fences the host when an old segment overflows its shared checkpoint or callback budget", () => {
  for (const code of ["boundary_overflow", "checkpoint_budget"]) {
    const r = replay();
    r.frame("cancel", { replacement: true }, { dir: "send" });
    r.frame("result", { status: "cancelled" });
    r.frame("send", { input: [] }, { segment: 1 });
    r.frame("error", { code, message: "checkpoint retained" });
    expect(
      Object.values(r.state.items).some(
        (item) => item.type === "notice" && item.text === "checkpoint retained",
      ),
    ).toBe(true);
    expect(deriveThreadStatus(r.state).state).not.toBe("done");
  }
});

it("uses the observed shell kind after an earlier partial call had no tool name", () => {
  const r = replay();
  r.frame("delta", { type: "partial-tool-call", callId: "shell", toolCall: {} });
  r.frame("delta", {
    type: "tool-call-started",
    callId: "shell",
    toolCall: { type: "shell", args: { command: "synthetic" } },
  });
  r.frame("shell-output", { callId: "shell", text: "live", toolCall: { type: "shell" } });
  expect(Object.values(r.state.items).find((item) => item.type === "tool_call")).toMatchObject({
    call: { kind: "shell", status: "running", detail: { output: { tail: "live" } } },
  });
});
