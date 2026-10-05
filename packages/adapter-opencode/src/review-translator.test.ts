import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { OpenCodeTranslator } from "./testing/v1/index.ts";
import { harness } from "./testing/v1/replay.ts";
function setup() {
  const h = harness();
  let seq = 0;
  const event = (type: string, properties: unknown, t = seq) =>
    h.feed({ seq: seq++, t, dir: "recv", channel: "sse", data: { payload: { type, properties } } });
  event("session.created", { info: { id: "root_native", directory: "/work" } });
  return { ...h, event };
}
it("settles an accepted prompt whose authentication error arrives before busy", () => {
  const h = setup();
  h.event("message.updated", { sessionID: "root_native", info: { id: "user", role: "user" } });
  h.event("session.error", {
    sessionID: "root_native",
    error: { name: "ProviderAuthError", data: { message: "login expired" } },
  });
  h.event("session.status", { sessionID: "root_native", status: { type: "idle" } });
  expect(h.view.thread.status.state).toBe("failed");
  expect(Object.values(h.view.runs)).toHaveLength(1);
  h.tick(100_000);
  expect(h.view.thread.status.state).toBe("failed");
});
it.each(["busy", "retry"])(
  "does not expire a child background result after the child resumes %s",
  (type) => {
    const h = setup();
    h.event("message.updated", { sessionID: "root_native", info: { id: "user", role: "user" } });
    h.event("session.status", { sessionID: "root_native", status: { type: "busy" } });
    h.event("session.created", {
      info: { id: "child", parentID: "root_native", directory: "/work" },
    });
    h.event("message.part.updated", {
      part: {
        id: "task",
        callID: "spawn",
        sessionID: "root_native",
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {},
          metadata: { sessionId: "child", background: true },
        },
      },
    });
    h.event("session.status", { sessionID: "root_native", status: { type: "idle" } });
    h.event("session.status", { sessionID: "child", status: { type: "idle" } }, 100);
    h.event(
      "session.status",
      { sessionID: "child", status: { type, message: "overloaded", next: 5000 } },
      200,
    );
    h.tick(3100);
    expect(Object.values(h.view.backgroundTasks)[0]?.status).toBe("running");
  },
);
it("uses receipt clocks rather than historical message creation time for retry", () => {
  const h = setup();
  h.feed({ seq: 20, t: 100, dir: "note", channel: "clock", data: { wallTime: 1_000_000 } });
  h.event(
    "message.updated",
    {
      sessionID: "root_native",
      info: { id: "old", role: "user", time: { created: -30_536_000_000 } },
    },
    100,
  );
  h.event(
    "session.status",
    { sessionID: "root_native", status: { type: "retry", next: 1_005_100, message: "overloaded" } },
    200,
  );
  expect(Object.values(h.view.agents)[0]?.status).toMatchObject({ until: 5200 });
});
it("retains future fields on recognized native session metadata", () => {
  const h = setup();
  h.event("session.updated", {
    info: { id: "root_native", directory: "/work", unknownFuture: 17 },
  });
  expect(JSON.stringify(h.diagnostics)).toContain('"unknownFuture":17');
  expect(JSON.stringify(h.view.items)).not.toContain('"unknownFuture":17');
});
it("bounds completed-part reconciliation while retaining live parts and recent deltas", () => {
  const translator = new OpenCodeTranslator({
    threadId: ThreadId.parse("thread_cache"),
    rootKey: "root",
  });
  const event = (type: string, properties: unknown) =>
    translator.translate(
      { seq: 0, t: 0, dir: "recv", channel: "sse", data: { payload: { type, properties } } },
      0,
    );
  event("message.part.updated", {
    part: { id: "active", sessionID: "s", type: "reasoning", text: "a" },
  });
  for (let i = 0; i < 2000; i++)
    event("message.part.updated", {
      part: {
        id: `completed_${i}`,
        sessionID: "s",
        type: "text",
        text: "x".repeat(2000),
        time: { end: 1 },
      },
    });
  const delta = (partID: string) =>
    event("message.part.delta", { sessionID: "s", partID, field: "text", delta: "b" });
  expect(delta("completed_0").some((f) => f.type === "item.delta")).toBe(false);
  expect(delta("completed_1999").some((f) => f.type === "item.delta")).toBe(true);
  expect(delta("active").some((f) => f.type === "item.delta")).toBe(true);
});
it("reports native usage and leaves returned raw evidence unchanged after later deltas", () => {
  const h = setup();
  h.event("message.part.updated", {
    part: {
      id: "usage",
      sessionID: "root_native",
      type: "step-finish",
      tokens: { input: 123, output: 45, cache: { read: 67 } },
      cost: 0.012,
    },
  });
  expect(Object.values(h.view.usage)[0]).toMatchObject({
    inputTokens: 123,
    outputTokens: 45,
    cachedInputTokens: 67,
    costUsd: 0.012,
  });
  const frame = {
    seq: 100,
    t: 100,
    dir: "recv" as const,
    channel: "sse",
    data: {
      payload: {
        type: "message.part.updated",
        properties: {
          part: { id: "thought", sessionID: "root_native", type: "reasoning", text: "a" },
        },
      },
    },
  };
  const original = structuredClone(frame);
  const facts = h.translator.translate(frame, 100);
  const evidence = structuredClone(facts);
  h.event("message.part.delta", {
    sessionID: "root_native",
    partID: "thought",
    field: "text",
    delta: "b",
  });
  expect(frame).toEqual(original);
  expect(facts).toEqual(evidence);
});

it("keeps raw nested tool input independent of later provider buffer reuse", () => {
  const h = setup();
  const data = {
    payload: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "shell",
          sessionID: "root_native",
          callID: "shell_call",
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "original" } },
        },
      },
    },
  };
  const facts = h.translator.translate({ seq: 99, t: 0, dir: "recv", channel: "sse", data }, 0);
  data.payload.properties.part.state.input.command = "reused";
  const tool = facts.find((f) => f.type === "item.upsert" && f.draft.type === "tool_call");
  expect(JSON.stringify(tool)).toContain('"command":"original"');
  expect(JSON.stringify(tool)).not.toContain("reused");
});
it("settles an accepted native message ID even if its user announcement is missing", () => {
  const h = setup();
  h.feed({
    seq: 50,
    t: 10,
    dir: "send",
    channel: "http",
    data: {
      method: "POST",
      path: "/session/root_native/prompt_async",
      body: { messageID: "accepted_user" },
    },
  });
  h.event("session.error", {
    sessionID: "root_native",
    error: { name: "ProviderAuthError", data: { message: "login expired" } },
  });
  h.event("session.status", { sessionID: "root_native", status: { type: "idle" } });
  expect(h.view.thread.status.state).toBe("failed");
  expect(Object.values(h.view.runs)).toMatchObject([
    { nativeId: "accepted_user", state: "failed" },
  ]);
});
it("keeps an unfamiliar native tool status live until a terminal update", () => {
  const h = setup();
  h.event("message.updated", { sessionID: "root_native", info: { id: "user", role: "user" } });
  h.event("session.status", { sessionID: "root_native", status: { type: "busy" } });
  const part = {
    id: "shell",
    callID: "shell_call",
    sessionID: "root_native",
    type: "tool",
    tool: "bash",
    state: { status: "future_pending_state", input: { command: "offline" } },
  };
  h.event("message.part.updated", { part });
  h.event("session.status", { sessionID: "root_native", status: { type: "idle" } });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  h.event("message.part.updated", {
    part: { ...part, state: { ...part.state, status: "completed" } },
  });
  expect(h.view.thread.status.state).toBe("done");
});
