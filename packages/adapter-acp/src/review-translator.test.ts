import { it, expect } from "vitest";
import { apply, createThreadState, type Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import {
  cursorAdapter,
  createAcpAdapter,
  cursorQuirks,
  createTranslatorIdentity,
} from "./index.ts";
import { harness, required, spawn, chunk, end } from "./test-helper.ts";
it("resume creates new items and runs while preserving earlier history", () => {
  const threadId = ThreadId.parse("preserved");
  const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
  let ids = 0;
  let seq = 0;
  const ctx = { now: 0, ids: { next: () => `id-${++ids}` } };
  let generation = 0;
  const adapter = createAcpAdapter(cursorQuirks, {
    identity: () => createTranslatorIdentity(`generation-${++generation}`),
  });
  function cycle(text: string) {
    const translator = adapter.createTranslator({ threadId, rootKey: "root" });
    for (const [dir, data] of [
      ["send", { id: 1, method: "session/load", params: { sessionId: "same", cwd: "/workspace" } }],
      ["recv", { id: 1, result: {} }],
      [
        "send",
        {
          id: 2,
          method: "session/prompt",
          params: { sessionId: "same", prompt: [{ type: "text", text }] },
        },
      ],
      ["recv", { id: 2, result: { stopReason: "end_turn" } }],
    ] as const) {
      ctx.now = ++seq;
      for (const fact of translator.translate({ dir, data, t: seq, seq, channel: "stdio" }, seq))
        apply(state, fact, ctx);
    }
  }
  cycle("first");
  cycle("second");
  expect(
    Object.values(state.items)
      .filter((item) => item.type === "message")
      .flatMap((item) => (item.type === "message" ? item.parts : [])),
  ).toEqual([
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ]);
  expect(Object.values(state.runs)).toHaveLength(2);
});
it("restarts work after an unexpected exit without retaining the old active turn", () => {
  const h = harness();
  h.ready();
  h.frame("note", { event: "process-exit", detail: { deliberate: false } });
  h.frame("note", { event: "process-start" });
  h.frame("send", {
    id: 3,
    method: "session/prompt",
    params: { sessionId: "root-session", prompt: [{ type: "text", text: "again" }] },
  });
  expect(h.state.status.state).toBe("working");
  expect(Object.values(h.state.runs)).toHaveLength(2);
});
it("does not carry deliberate stop across a reopened process", () => {
  const h = harness();
  h.ready();
  end(h);
  h.frame("note", { event: "stop" });
  h.frame("note", { event: "process-exit" });
  h.frame("note", { event: "process-start" });
  h.frame("send", {
    id: 3,
    method: "session/prompt",
    params: { sessionId: "root-session", prompt: [] },
  });
  h.frame("note", { event: "process-exit", detail: { deliberate: false } });
  expect(h.state.status.state).toBe("failed");
});
it("reopens a synthetically interrupted child when late live text proves it is running", () => {
  const h = harness();
  h.ready();
  spawn(h);
  chunk(h, "before", "child");
  h.frame("recv", { id: 2, result: { stopReason: "cancelled" } }, 1000);
  h.tick(12999);
  expect(
    required(h.state.agents[Object.keys(h.state.agents).find((key) => key !== "root") ?? "missing"])
      .agent.status.state,
  ).not.toBe("interrupted");
  h.tick(13000);
  h.update(
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still alive" } },
    "child",
    13001,
  );
  expect(h.state.status.state).toBe("working");
});
it("holds completion for a shell whose execution remains unknown after interruption", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "sleep 60" },
  });
  end(h, "cancelled");
  expect(Object.values(h.state.tasks)[0]?.status).toBe("unknown");
  expect(h.state.status.state).toBe("waiting");
});
it("publishes unresponsive rather than working for a disconnected child", () => {
  const h = harness();
  h.ready();
  spawn(h);
  chunk(h, "work", "child");
  end(h);
  h.update({
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "child",
    state: "disconnected",
  });
  expect(h.state.status.state).toBe("unresponsive");
  expect(
    Object.values(h.state.agents).find((record) => record.agent.native.nativeId === "child")?.agent
      .status.state,
  ).toBe("unresponsive");
});
it("retains complete child envelopes including unknown params and outer fields", () => {
  const translator = cursorAdapter.createTranslator({
    threadId: ThreadId.parse("raw"),
    rootKey: "root",
  });
  const frame = {
    seq: 0,
    t: 1,
    dir: "recv" as const,
    channel: "stdio",
    data: {
      method: "session/update",
      vendorOuter: "retained",
      params: {
        sessionId: "parent",
        vendorParams: "retained",
        update: {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: "child",
          vendorChild: "retained",
        },
      },
    },
  };
  const facts = translator.translate(frame, 1);
  expect(JSON.stringify(facts)).toContain('"vendorOuter":"retained"');
  expect(JSON.stringify(facts)).toContain('"vendorParams":"retained"');
});
it("emits a bounded raw change for each tool refresh while retaining its initial input", () => {
  const translator = cursorAdapter.createTranslator({
    threadId: ThreadId.parse("bounded"),
    rootKey: "root",
  });
  let seq = 0;
  const emitted: Fact[] = [];
  for (let n = 0; n < 200; n++) {
    const update =
      n === 0
        ? {
            sessionUpdate: "tool_call",
            toolCallId: "tool",
            kind: "read",
            rawInput: { path: "/original", important: true },
            status: "in_progress",
          }
        : {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool",
            title: `Refresh ${n}`,
            future: "x".repeat(1000),
          };
    emitted.push(
      ...translator.translate(
        {
          seq: ++seq,
          t: seq,
          dir: "recv",
          channel: "stdio",
          data: { method: "session/update", params: { sessionId: "session", update } },
        },
        seq,
      ),
    );
  }
  const raws = emitted
    .filter((f) => f.type === "item.upsert" && f.draft.type === "tool_call")
    .map((f) =>
      f.type === "item.upsert" && f.draft.type === "tool_call" ? f.draft.call?.raw : undefined,
    );
  expect(Math.max(...raws.map((raw) => raw?.length ?? 0))).toBeLessThanOrEqual(2);
  expect(JSON.stringify(emitted)).toContain('"important":true');
});

it("releases an uncertain shell only when a later terminal update confirms its completion", () => {
  const h = harness();
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "sleep 60" },
  });
  end(h, "cancelled");
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  h.update({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    status: "completed",
    rawOutput: { exitCode: 0 },
  });
  expect(h.state.status.state).toBe("done");
  expect(Object.values(h.state.tasks)[0]?.status).toBe("completed");
});
it("reconnects a disconnected child when direct live traffic arrives", () => {
  const h = harness();
  h.ready();
  spawn(h);
  end(h);
  h.update({
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "child",
    state: "disconnected",
  });
  expect(
    Object.values(h.state.agents).find((record) => record.agent.native.nativeId === "child")?.agent
      .status.state,
  ).toBe("unresponsive");
  chunk(h, "connected again", "child");
  expect(h.state.status.state).toBe("working");
});

it("accepts legacy core snapshots and preserves unknown shell completion", () => {
  const h = harness();
  delete h.state.uncertainTasks;
  h.ready();
  h.update({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    kind: "execute",
    status: "in_progress",
  });
  end(h, "cancelled");
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
});
it("preserves the complete transcript while bounding retained error diagnostics", () => {
  const h = harness();
  h.ready();
  const text = "\n\nError: " + "detail".repeat(10000);
  chunk(h, text);
  end(h);
  expect(h.state.status.state).toBe("failed");
  const status = required(h.state.agents["root"]).agent.status;
  expect(status.state === "failed" ? status.error.message?.length : undefined).toBeLessThanOrEqual(
    8192,
  );
  expect(
    Object.values(h.state.items).flatMap((item) => (item.type === "message" ? item.parts : [])),
  ).toContainEqual({ type: "text", text });
});
it("does not carry disconnected child uncertainty into a successfully reopened process", () => {
  const h = harness();
  h.ready();
  spawn(h);
  end(h);
  h.update({
    sessionUpdate: "subagent_state_update",
    subagentSessionId: "child",
    state: "disconnected",
  });
  h.frame("note", { event: "process-exit", detail: { deliberate: false } });
  h.frame("note", { event: "process-start" });
  h.frame("send", {
    id: 3,
    method: "session/prompt",
    params: { sessionId: "root-session", prompt: [] },
  });
  h.frame("recv", { id: 3, result: { stopReason: "end_turn" } });
  expect(h.state.status.state).toBe("done");
});
it("does not wait for historical children when a new process cancels its first prompt", () => {
  const h = harness();
  h.ready();
  spawn(h);
  end(h);
  h.frame("note", { event: "process-exit", detail: { deliberate: true } });
  h.frame("note", { event: "process-start" });
  h.frame("send", {
    id: 3,
    method: "session/prompt",
    params: { sessionId: "root-session", prompt: [] },
  });
  h.frame("recv", { id: 3, result: { stopReason: "cancelled" } });
  expect(h.state.status.state).toBe("done");
});
