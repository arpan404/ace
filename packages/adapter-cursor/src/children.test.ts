import { expect, it } from "vitest";
import { deriveThreadStatus } from "@ace/core";
import { replay } from "./translator-test-support.ts";

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
