import { expect, it } from "vitest";
import { chunk, end, harness, spawn } from "./test-helper.ts";
import { resumeLoadFailure } from "./resume-error.ts";

const agentState = (h: ReturnType<typeof harness>, nativeId: string) =>
  Object.values(h.state.agents).find((a) => a.agent.native.nativeId === nativeId)?.agent.status
    .state;
const notices = (h: ReturnType<typeof harness>) =>
  Object.values(h.state.items).flatMap((item) => (item.type === "notice" ? [item.text] : []));

it("an unknown stop reason ends the turn and says so", () => {
  const h = harness();
  h.ready();
  h.frame("recv", { id: 2, result: { stopReason: "future_paused" } });
  expect(h.state.status.state).toBe("done");
  expect(notices(h)).toContainEqual(expect.stringContaining("future_paused"));
});

it("a stray session's turn ends with the root's prompt", () => {
  const h = harness();
  h.ready();
  chunk(h, "unannounced", "stray");
  expect(agentState(h, "stray")).toBe("working");
  end(h);
  expect(agentState(h, "stray")).not.toBe("working");
  expect(h.state.status.state).toBe("done");
});

it("an end-only tool frame after a child finished does not reopen the child", () => {
  const h = harness();
  h.ready();
  spawn(h, "kid");
  h.update({
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "kid",
    state: "completed",
  });
  end(h);
  expect(h.state.status.state).toBe("done");
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "late", status: "completed" }, "kid");
  expect(agentState(h, "kid")).not.toBe("working");
  expect(h.state.status.state).toBe("done");
});

it("text after the prompt's reply attaches without reopening the turn", () => {
  const h = harness();
  h.ready();
  end(h);
  chunk(h, "afterthought");
  expect(h.state.status.state).toBe("done");
});

it("a tool running after the prompt's reply holds the root working until it settles", () => {
  const h = harness();
  h.ready();
  end(h);
  h.update({ sessionUpdate: "tool_call", toolCallId: "pr", kind: "read", status: "in_progress" });
  expect(h.state.status.state).toBe("working");
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "pr", status: "completed" });
  expect(h.state.status.state).toBe("done");
});

it("a tool first reported after the prompt's reply is work holding the next prompt until it settles", () => {
  const h = harness();
  h.ready();
  end(h);
  h.update({ sessionUpdate: "tool_call", toolCallId: "late", kind: "read", status: "in_progress" });
  // The session takes no new prompt while it runs, and says so: a Stop can end it.
  expect(Object.values(h.state.tasks)).toMatchObject([
    { kind: "other", stoppable: false, blocksPrompts: true, status: "running" },
  ]);
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "late", status: "completed" });
  expect(Object.values(h.state.tasks)).toMatchObject([{ status: "completed" }]);
  expect(h.state.status.state).toBe("done");
});

it("a child cancelled directly is given up as interrupted when it stays silent past the grace", () => {
  const h = harness();
  h.ready();
  spawn(h, "quiet");
  end(h);
  expect(agentState(h, "quiet")).toBe("working");
  h.frame("send", { method: "session/cancel", params: { sessionId: "quiet" } }, 100);
  h.tick(100 + 11_999);
  expect(agentState(h, "quiet")).toBe("working");
  h.tick(100 + 12_000);
  expect(agentState(h, "quiet")).not.toBe("working");
  expect(h.state.status.state).toBe("done");
});

it.each([
  [{ code: -32002, message: "Resource not found" }],
  [{ code: -32603, message: "Internal error: Session not found" }],
])("a resume refused as %o reads as an unavailable session", (error) => {
  expect(resumeLoadFailure(new Error(JSON.stringify(error)))?.code).toBe("resume_unavailable");
});

it("an internal error about something else is not taken for a missing session", () => {
  expect(
    resumeLoadFailure(new Error(JSON.stringify({ code: -32603, message: "Internal error" }))),
  ).toBeUndefined();
});
