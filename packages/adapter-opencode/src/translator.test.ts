import { describe, expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { harness } from "./replay.ts";
import { OpenCodeTranslator } from "./index.ts";
function setup() {
  const h = harness();
  let seq = 0;
  const event = (type: string, properties: unknown = {}, t = seq) =>
    h.feed({ seq: seq++, t, dir: "recv", channel: "sse", data: { payload: { type, properties } } });
  event("session.created", { info: { id: "ses_root", directory: "/work" } });
  const user = (id = "msg_user", sessionID = "ses_root") =>
    event("message.updated", { sessionID, info: { id, sessionID, role: "user" } });
  const status = (type: string, sessionID = "ses_root") =>
    event("session.status", { sessionID, status: { type } });
  const tool = (
    name: string,
    nativeStatus: string,
    extra: Record<string, unknown> = {},
    sessionID = "ses_root",
  ) =>
    event("message.part.updated", {
      part: {
        id: `part_${name}`,
        sessionID,
        messageID: "msg_assistant",
        type: "tool",
        tool: name,
        callID: `call_${name}`,
        state: { status: nativeStatus, input: { command: "echo hi", filePath: "x.ts" }, ...extra },
      },
    });
  return { ...h, event, user, status, tool };
}
describe("OpenCode translation", () => {
  it("links an announced child to its later task without creating a second agent", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.tool("task", "pending");
    h.event("session.created", {
      info: { id: "ses_child", parentID: "ses_root", directory: "/work" },
    });
    h.tool("task", "running", { metadata: { sessionId: "ses_child" } });
    h.user("msg_child", "ses_child");
    h.status("busy", "ses_child");
    expect(h.view.thread.status.state).toBe("working");
    const child = Object.values(h.view.agents).find((a) => a.native.nativeId === "ses_child");
    const spawn = Object.values(h.view.items).find((i) => i.type === "tool_call");
    expect(child?.spawnedBy).toBe(spawn?.id);
    expect(Object.values(h.view.agents)).toHaveLength(2);
    expect(
      Object.values(h.view.agents).find((a) => a.native.nativeId === "ses_root")?.status,
    ).toMatchObject({ state: "blocked", on: "subagents" });
  });
  it("keeps an interrupted shell live through duplicate idles until terminal output", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.tool("bash", "running");
    h.event("session.error", { sessionID: "ses_root", error: { name: "MessageAbortedError" } });
    h.status("idle");
    h.status("idle");
    expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
    h.tool("bash", "completed", { output: "User aborted the command", metadata: { exit: null } });
    expect(h.view.thread.status.state).toBe("done");
    expect(Object.values(h.view.items).find((i) => i.type === "tool_call")).toMatchObject({
      call: { status: "cancelled" },
    });
    expect(Object.values(h.view.runs)).toHaveLength(1);
    expect(Object.values(h.view.runs)[0]?.state).toBe("interrupted");
  });
  it("waits for delivered background results and labels the self-started run", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.event("session.created", {
      info: { id: "ses_child", parentID: "ses_root", directory: "/work" },
    });
    h.tool("task", "completed", { metadata: { sessionId: "ses_child", background: true } });
    h.user("msg_child", "ses_child");
    h.status("busy", "ses_child");
    h.status("idle");
    h.status("idle", "ses_child");
    expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
    h.user("msg_injected");
    h.event("message.part.updated", {
      part: {
        id: "part_result",
        sessionID: "ses_root",
        messageID: "msg_injected",
        type: "text",
        synthetic: true,
        text: '<task id="ses_child" state="completed">result</task>',
      },
    });
    expect(h.view.thread.status.state).toBe("working");
    h.status("busy");
    h.status("idle");
    expect(Object.values(h.view.runs).at(-1)?.trigger).toBe("subagent_result");
    expect(h.view.thread.status.state).toBe("done");
  });
  it("releases a background job after the result-delivery grace period", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.event("session.created", {
      info: { id: "ses_child", parentID: "ses_root", directory: "/work" },
    });
    h.tool("task", "completed", { metadata: { sessionId: "ses_child", background: true } });
    h.user("msg_child", "ses_child");
    h.status("busy", "ses_child");
    h.status("idle");
    h.event("session.status", { sessionID: "ses_child", status: { type: "idle" } }, 100);
    h.tick(3099);
    expect(h.view.thread.status.state).toBe("waiting");
    h.tick(3100);
    expect(h.view.thread.status.state).toBe("done");
  });
  for (const [message, on] of [
    ["429 too many requests", "rate_limit"],
    ["ECONNRESET socket closed", "network"],
    ["backend overloaded", "upstream"],
  ]) {
    it(`holds a ${on} retry until a busy signal`, () => {
      const h = setup();
      h.user();
      h.status("busy");
      h.event("session.status", {
        sessionID: "ses_root",
        status: { type: "retry", message, next: 20, attempt: 2 },
      });
      h.tick(21);
      expect(h.view.thread.status).toEqual({ state: "waiting", on });
      h.status("busy");
      expect(h.view.thread.status.state).toBe("working");
    });
  }
  it("routes reasoning text deltas to reasoning and preserves the input frame", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.event("message.part.updated", {
      part: { id: "thought", sessionID: "ses_root", type: "reasoning", text: "a" },
    });
    h.event("message.part.delta", {
      sessionID: "ses_root",
      partID: "thought",
      field: "text",
      delta: "b",
    });
    expect(Object.values(h.view.items).find((i) => i.type === "reasoning")).toMatchObject({
      text: "ab",
    });
    expect(Object.values(h.view.agents)[0]?.status).toMatchObject({
      state: "working",
      activity: "thinking",
    });
  });
  it("resolves rejected questions as dismissed and declines the backing tool", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.tool("question", "pending");
    h.event("question.asked", {
      id: "que_1",
      sessionID: "ses_root",
      questions: [{ question: "Which?", options: [{ label: "One" }] }],
      tool: { callID: "call_question" },
    });
    h.tool("question", "running");
    expect(h.view.thread.status.state).toBe("needs_you");
    h.event("question.rejected", { sessionID: "ses_root", requestID: "que_1" });
    h.tool("question", "error", { error: "The user dismissed this question" });
    h.status("idle");
    expect(Object.values(h.view.interactions)[0]).toMatchObject({
      state: "resolved",
      request: { questions: [{ allowOther: true, multiSelect: false }] },
      resolution: { kind: "question", dismissed: true },
    });
    expect(Object.values(h.view.items).find((i) => i.type === "tool_call")).toMatchObject({
      call: { status: "declined" },
    });
    expect(h.view.thread.status.state).toBe("done");
  });
  it("turns plan_exit into a review and treats rejection as a completed turn", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.tool("plan_exit", "pending");
    h.event("question.asked", {
      id: "que_plan",
      sessionID: "ses_root",
      questions: [{ question: "Build?" }],
      tool: { callID: "call_plan_exit" },
    });
    h.event("question.rejected", { sessionID: "ses_root", requestID: "que_plan" });
    h.tool("plan_exit", "error", { error: "The user dismissed this question" });
    h.status("idle");
    expect(Object.values(h.view.interactions)[0]).toMatchObject({
      request: { kind: "plan_review" },
      resolution: { kind: "plan_review", decision: "reject" },
    });
    expect(Object.values(h.view.runs)[0]?.state).toBe("completed");
  });
  it("does not infer failure from ordinary assistant text", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.event("message.part.updated", {
      part: {
        id: "text",
        sessionID: "ses_root",
        type: "text",
        text: "Error: a file was not found, but I fixed it",
      },
    });
    h.status("idle");
    expect(h.view.thread.status.state).toBe("done");
  });
  it("expires requests on transport loss and can reopen them during resync", () => {
    const h = setup();
    h.user();
    h.status("busy");
    const p = { id: "per_1", sessionID: "ses_root", permission: "bash" };
    h.event("permission.asked", p);
    h.feed({ seq: 100, t: 10, dir: "note", channel: "lifecycle", data: { type: "disconnected" } });
    expect(Object.values(h.view.interactions)[0]?.state).toBe("expired");
    h.event("permission.asked", p);
    expect(h.view.thread.status.state).toBe("needs_you");
  });
  it("retains unknown data and ignores sync twins without duplicating output", () => {
    const h = setup();
    h.user();
    h.status("busy");
    const p = { futureField: { useful: 42 } };
    h.event("future.event", p);
    h.event("message.part.updated", {
      part: { id: "p1", sessionID: "ses_root", type: "text", text: "hello" },
    });
    h.event("sync", {
      data: { part: { id: "p1", sessionID: "ses_root", type: "text", text: "hello" } },
    });
    expect(Object.values(h.view.items).filter((i) => i.type === "message")).toHaveLength(1);
    expect(
      Object.values(h.view.items).find(
        (i) => i.type === "notice" && i.text === "OpenCode future.event",
      ),
    ).toMatchObject({
      raw: [{ data: { payload: { properties: p } } }],
    });
    const translator = new OpenCodeTranslator({
      threadId: ThreadId.parse("thread_x"),
      rootKey: "root",
    });
    for (const data of [
      null,
      [],
      true,
      "bad",
      { payload: { type: "message.part.updated", properties: { part: null } } },
    ])
      expect(() =>
        translator.translate({ seq: 0, t: 0, dir: "recv", channel: "sse", data }, 0),
      ).not.toThrow();
  });
  it("keeps transport liveness healthy during long retries, then detects heartbeat loss", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.event(
      "session.status",
      { sessionID: "ses_root", status: { type: "retry", message: "overloaded", next: 100_000 } },
      100,
    );
    h.event("server.heartbeat", {}, 20_000);
    h.tick(44_999);
    expect(h.view.thread.status).toEqual({ state: "waiting", on: "upstream" });
    h.tick(45_001);
    expect(h.view.thread.status.state).toBe("unresponsive");
  });
  it("recovers a turn that started and finished entirely during an outage", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.status("idle");
    h.user("missed_user");
    h.event("message.updated", {
      sessionID: "ses_root",
      info: {
        id: "missed_assistant",
        role: "assistant",
        parentID: "missed_user",
        time: { completed: 10 },
      },
    });
    h.status("idle");
    expect(h.view.thread.status.state).toBe("done");
    expect(Object.values(h.view.runs)).toHaveLength(2);
  });
  it("fails a native authentication error while ordinary text errors remain text", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.event("session.error", {
      sessionID: "ses_root",
      error: { name: "ProviderAuthError", data: { message: "login expired" } },
    });
    h.status("idle");
    expect(h.view.thread.status.state).toBe("failed");
    expect(Object.values(h.view.agents)[0]?.status).toMatchObject({
      state: "failed",
      error: { kind: "auth", message: "login expired" },
    });
  });
  it("clears pending-input wake when a prompt cannot be delivered", () => {
    const h = setup();
    h.feed({
      seq: 50,
      t: 10,
      dir: "send",
      channel: "http",
      data: {
        method: "POST",
        path: "/session/ses_root/prompt_async",
        body: { messageID: "msg_failed" },
      },
    });
    expect(h.view.thread.status.state).toBe("working");
    h.feed({
      seq: 51,
      t: 11,
      dir: "note",
      channel: "transport",
      data: {
        type: "request.failed",
        path: "/session/ses_root/prompt_async",
        messageID: "msg_failed",
        message: "ECONNRESET",
      },
    });
    expect(h.view.thread.status.state).toBe("failed");
  });
  it("includes the observed plan file contents in plan review", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.tool("write", "completed", {
      input: { filePath: "/work/.opencode/plans/plan.md", content: "# Plan\nChange x" },
    });
    h.tool("plan_exit", "pending");
    h.event("question.asked", {
      id: "que_plan",
      sessionID: "ses_root",
      questions: [],
      tool: { callID: "call_plan_exit" },
    });
    expect(Object.values(h.view.interactions)[0]?.request).toMatchObject({
      kind: "plan_review",
      markdown: "# Plan\nChange x",
      planPath: "/work/.opencode/plans/plan.md",
    });
  });
  it("starts child work when busy arrives before its prompting user message", () => {
    const h = setup();
    h.user();
    h.status("busy");
    h.event("session.created", { info: { id: "ses_child", parentID: "ses_root" } });
    h.status("busy", "ses_child");
    h.user("child_user", "ses_child");
    h.event("message.part.updated", {
      part: { id: "child_thought", sessionID: "ses_child", type: "reasoning", text: "thinking" },
    });
    expect(
      Object.values(h.view.agents).find((a) => a.native.nativeId === "ses_child")?.status,
    ).toMatchObject({ state: "working", activity: "thinking" });
    expect(Object.values(h.view.runs).filter((r) => r.nativeId === "child_user")).toHaveLength(1);
  });
  it("converts native retry deadlines into the injected replay clock", () => {
    const h = setup();
    h.feed({ seq: 99, t: 10, dir: "note", channel: "clock", data: { wallTime: 10_000 } });
    h.event(
      "message.updated",
      { sessionID: "ses_root", info: { id: "msg_clock", role: "user", time: { created: 10_000 } } },
      10,
    );
    h.status("busy");
    h.event(
      "session.status",
      {
        sessionID: "ses_root",
        status: { type: "retry", message: "overloaded", next: 11_000, attempt: 1 },
      },
      20,
    );
    expect(Object.values(h.view.agents)[0]?.status).toMatchObject({
      state: "blocked",
      on: "upstream",
      until: 1010,
    });
  });
});
