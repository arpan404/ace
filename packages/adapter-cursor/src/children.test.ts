import { expect, it } from "vitest";
import { deriveThreadStatus } from "@ace/core";
import { replay } from "./translator-test-support.ts";

it("normal disposal after a completed child-free turn creates no runtime warning", () => {
  const r = replay();
  r.frame("result", { status: "finished" });
  const before = r.events.length;
  r.frame("host-exit", { deliberate: true });
  expect(r.events.slice(before)).toEqual([]);
  expect(deriveThreadStatus(r.state).state).toBe("done");
});

it("links a late native child ID once and waits for foreground task completion", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "task",
    toolCall: { type: "task", args: { description: "child", model: "composer-2.5" } },
  });
  r.frame("delta", {
    type: "tool-call-delta",
    callId: "task",
    taskUpdate: { type: "text-delta", text: "child output" },
  });
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
  expect(
    Object.values(r.state.agents).find((record) => record.agent.origin === "provider_subagent")
      ?.activeRun,
  ).toBeDefined();
  const complete = {
    type: "tool-call-completed",
    callId: "task",
    toolCall: {
      type: "task",
      result: { status: "success", value: { agentId: "native-child", isBackground: false } },
    },
  };
  r.frame("delta", complete);
  r.frame("delta", complete);
  r.frame("result", { status: "finished" });
  expect(Object.values(r.state.agents)).toHaveLength(2);
  expect(
    Object.values(r.state.agents).find((record) => record.agent.origin === "provider_subagent")
      ?.agent,
  ).toMatchObject({
    native: { nativeId: "native-child" },
    fidelity: "summary",
    status: { state: "idle" },
  });
  expect(deriveThreadStatus(r.state).state).toBe("done");
});
it("keeps background child dispatch alive after the root result and host exit", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "background",
    toolCall: { type: "task", args: { description: "background task" } },
  });
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "background",
    toolCall: {
      type: "task",
      result: { status: "success", value: { agentId: "child", isBackground: true } },
    },
  });
  r.frame("result", { status: "finished" });
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
  expect(Object.values(r.state.tasks)).toHaveLength(1);
  r.frame("host-exit", { deliberate: true });
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
  expect(
    Object.values(r.state.agents).find((record) => record.agent.origin === "provider_subagent")
      ?.activeRun,
  ).toBeDefined();
});
it("does not settle an unresolved foreground child during a steering cancellation", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "task",
    toolCall: { type: "task", args: {} },
  });
  r.frame("cancel", { replacement: true }, { dir: "send" });
  r.frame("result", { status: "cancelled" });
  r.frame("send", { input: [] }, { segment: 1 });
  r.frame("result", { status: "finished" }, { segment: 1 });
  expect(
    Object.values(r.state.runs).filter((run) => run.agentId === r.state.agents.root?.agent.id),
  ).toHaveLength(1);
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
});
it("creates visible nested children while retaining the SDK one-level transcript warning", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "parent",
    toolCall: { type: "task", args: {} },
  });
  r.frame("delta", {
    type: "tool-call-delta",
    callId: "parent",
    taskUpdate: {
      type: "tool-call-started",
      callId: "grandchild",
      toolCall: { type: "task", args: {} },
    },
  });
  r.frame("delta", {
    type: "tool-call-delta",
    callId: "parent",
    taskUpdate: {
      type: "tool-call-delta",
      callId: "grandchild",
      taskUpdate: { type: "text-delta", text: "unverified" },
    },
  });
  r.frame("result", { status: "finished" });
  expect(Object.values(r.state.agents)).toHaveLength(3);
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
  expect(
    Object.values(r.state.items).some(
      (item) => item.type === "notice" && item.text.includes("beyond one level"),
    ),
  ).toBe(true);
});
it("preserves an open shell before ending its owning root turn", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "shell",
    toolCall: { type: "shell", args: { command: "long build" } },
  });
  r.frame("result", { status: "cancelled" });
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
  expect(Object.values(r.state.tasks)).toHaveLength(1);
  expect(Object.values(r.state.items).find((item) => item.type === "tool_call")?.call.status).toBe(
    "running",
  );
});

it("preserves child-owned shell work and closes child text before foreground task success", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "task",
    toolCall: { type: "task", args: {} },
  });
  for (const taskUpdate of [
    { type: "text-delta", text: "child text" },
    {
      type: "tool-call-started",
      callId: "shell",
      toolCall: { type: "shell", args: { command: "synthetic" } },
    },
  ])
    r.frame("delta", { type: "tool-call-delta", callId: "task", taskUpdate });
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "task",
    toolCall: { type: "task", result: { status: "success", value: { isBackground: false } } },
  });
  r.frame("result", { status: "finished" });
  const shell = Object.values(r.state.items).find(
    (item) => item.type === "tool_call" && item.call.kind === "shell",
  );
  expect(shell).toMatchObject({ complete: false, call: { status: "running" } });
  expect(Object.values(r.state.tasks)).toMatchObject([{ status: "unknown" }]);
  expect(deriveThreadStatus(r.state)).toEqual({ state: "waiting", on: "background_task" });
  expect(
    Object.values(r.state.items).find(
      (item) => item.type === "message" && item.role === "assistant",
    ),
  ).toMatchObject({ complete: true });
});

it("closes a text-only child message at task completion before the root turn ends", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "task",
    toolCall: { type: "task", args: {} },
  });
  r.frame("delta", {
    type: "tool-call-delta",
    callId: "task",
    taskUpdate: { type: "text-delta", text: "child text only" },
  });
  const message = Object.values(r.state.items).find(
    (item) => item.type === "message" && item.role === "assistant",
  );
  if (!message || message.type !== "message") throw new Error("Missing child message");
  expect(message).toMatchObject({
    complete: false,
    parts: [{ type: "text", text: "child text only" }],
  });
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "task",
    toolCall: { type: "task", result: { status: "success", value: { isBackground: false } } },
  });
  expect(
    r.events.findLast((event) => event.type === "item.updated" && event.item.id === message.id),
  ).toMatchObject({ type: "item.updated", item: { id: message.id, complete: true } });
  expect(r.state.agents.root?.activeRun).toBeDefined();
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
});
