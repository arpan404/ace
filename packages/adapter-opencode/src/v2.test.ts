import { readFileSync } from "node:fs";
import { z } from "zod";
import { expect, it } from "vitest";
import { harness } from "./replay.ts";
function setup() {
  const h = harness();
  let seq = 0;
  const frame = (channel: string, data: unknown, dir: "recv" | "send" | "note" = "recv") =>
    h.feed({ seq: seq++, t: seq, dir, channel, data });
  const event = (
    type: string,
    data: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) =>
    frame("sse", {
      id: `e${seq}`,
      created: seq,
      type,
      data: { sessionID: "s-root", ...data },
      location: { directory: "/one" },
      ...extra,
    });
  frame("lifecycle", { type: "started" }, "note");
  event("session.created", { projectID: "p", location: { directory: "/one" } });
  return { ...h, event, frame };
}
it("OpenCode step usage replaces occupied context while session billing stays cumulative", () => {
  const h = setup();
  h.frame("snapshot.info", {
    root: true,
    info: {
      id: "s-root",
      projectID: "p",
      location: { directory: "/one" },
      model: { providerID: "local", id: "model" },
    },
  });
  h.event("session.execution.started");
  const step = {
    assistantMessageID: "m1",
    tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 20 } },
    cost: 0.001,
  };
  h.event("session.step.ended", step);
  h.event("session.usage.updated", { ...step, cost: 0.0017 });
  h.event("session.step.ended", {
    ...step,
    assistantMessageID: "m2",
    tokens: { input: 20, output: 5, cache: { read: 10, write: 0 } },
  });
  h.event("session.usage.updated", {
    tokens: { input: 120, output: 15, reasoning: 5, cache: { read: 60, write: 20 } },
    cost: 0.0027,
  });
  h.event("session.execution.succeeded");
  expect(
    h.events.filter((event) => event.type === "context.sampled").map((sample) => sample.usedTokens),
  ).toEqual([185, 35]);
  expect(Object.values(h.view.usage)).toMatchObject([{ model: "local/model", costUsd: 0.0027 }]);
  expect(
    Object.values(h.view.agents).find((agent) => agent.native.nativeId === "s-root")?.model,
  ).toBe("local/model");
});
it("step completion and HTTP admission leave work unsettled until execution terminal evidence", () => {
  const h = setup();
  h.frame(
    "http",
    {
      method: "POST",
      path: "/api/session/s-root/prompt",
      body: { id: "input-1", text: "Do work" },
    },
    "send",
  );
  h.frame("http", {
    method: "POST",
    path: "/api/session/s-root/prompt",
    status: 200,
    body: { data: { id: "input-1", sessionID: "s-root" } },
  });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "queue" });
  h.event("session.inbox.delivered", { inboxID: "input-1" });
  h.event("session.execution.started");
  h.event("session.step.streamed");
  h.event("session.step.ended");
  expect(h.view.thread.status.state).toBe("working");
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
  expect(Object.values(h.view.runs)).toHaveLength(1);
});
it("empty inbox snapshots cannot settle an input with an uncertain admission receipt", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  h.frame(
    "http",
    {
      method: "POST",
      path: "/api/session/s-root/prompt",
      body: { id: "uncertain", text: "work" },
    },
    "send",
  );
  h.frame("input.uncertain", { id: "uncertain" }, "note");
  h.frame("lifecycle", { type: "disconnected" }, "note");
  h.frame("snapshot.inbox", { sessionID: "s-root", items: [] });
  h.frame("snapshot.inbox", { sessionID: "s-root", items: [] });
  h.frame("snapshot.active", { sessionID: "s-root", running: false, idleAt: 100 });
  h.frame("lifecycle", { type: "resynced" }, "note");
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  expect(h.queueCount()).toBe(0);
  h.event("session.inbox.delivered", { inboxID: "uncertain" });
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
});
it("duplicate native terminals and projected idle markers never create a second turn", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  h.event("session.execution.succeeded");
  h.frame("snapshot.message", {
    sessionID: "s-root",
    message: { id: "idle", type: "idle", outcome: "succeeded" },
  });
  h.frame("snapshot.active", { sessionID: "s-root", running: false, outcome: "succeeded" });
  expect(Object.values(h.view.runs)).toHaveLength(1);
  expect(h.view.thread.status.state).toBe("done");
});
it("a root waits for a background child, its human answer and synthetic completion wake", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.created", {
    sessionID: "child",
    parentID: "s-root",
    projectID: "p",
    location: { directory: "/one" },
  });
  h.event("session.tool.called", {
    assistantMessageID: "a",
    id: "t",
    name: "subagent",
    input: { background: true },
  });
  h.event("session.tool.success", {
    assistantMessageID: "a",
    id: "t",
    content: [{ type: "text", text: "Started" }],
    metadata: { sessionID: "child", status: "running" },
  });
  h.event("session.execution.started", { sessionID: "child" });
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).not.toBe("done");
  h.event("permission.asked", {
    sessionID: "child",
    id: "ask",
    action: "edit",
    resources: ["x.ts"],
    source: { type: "tool", messageID: "ca", id: "ct" },
  });
  expect(h.view.thread.status.state).toBe("needs_you");
  const request = Object.values(h.view.interactions)[0];
  expect(request?.request).toMatchObject({
    kind: "approval",
    options: [
      { id: "once" },
      { id: "always", kind: "allow_always", label: "Allow for project" },
      { id: "reject" },
    ],
  });
  h.event("permission.replied", { sessionID: "child", requestID: "ask", reply: "once" });
  h.event("session.execution.succeeded", { sessionID: "child" });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  h.event("session.synthetic", {
    metadata: { source: "subagent", childID: "child", state: "completed" },
  });
  expect(h.view.thread.status.state).not.toBe("done");
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
  expect(Object.values(h.view.runs).at(-1)?.trigger).toBe("subagent_result");
});
it("a native background shell survives spawning-tool success and root success", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.tool.input.started", { assistantMessageID: "a", id: "t", name: "shell" });
  h.event("session.tool.called", {
    assistantMessageID: "a",
    id: "t",
    input: { command: "work", background: true },
  });
  h.event("session.tool.progress", {
    assistantMessageID: "a",
    id: "t",
    metadata: { shellID: "shell-1" },
  });
  h.event("session.tool.success", {
    assistantMessageID: "a",
    id: "t",
    content: [{ type: "text", text: "Backgrounded" }],
    metadata: { shellID: "shell-1", status: "running" },
  });
  h.event("session.execution.succeeded");
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  h.event("shell.exited", { id: "shell-1", exit: 0, status: "exited" });
  expect(h.view.thread.status.state).not.toBe("done");
  h.event("session.synthetic", {
    metadata: { source: "shell", shellID: "shell-1", state: "completed" },
  });
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
});
it("interrupt receipts and terminal execution preserve a running tool until cleanup", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.tool.input.started", { assistantMessageID: "a", id: "t", name: "shell" });
  h.frame("http", {
    method: "POST",
    path: "/api/session/s-root/interrupt",
    status: 200,
    body: { interrupted: true },
  });
  expect(h.view.thread.status.state).toBe("working");
  h.event("session.execution.interrupted");
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  h.event("session.tool.failed", {
    assistantMessageID: "a",
    id: "t",
    error: { message: "Cancelled" },
  });
  expect(h.view.thread.status.state).toBe("done");
});
it("keyed question forms keep multi-select answers and dismissal", () => {
  const h = setup();
  h.event("form.created", {
    form: {
      id: "f",
      sessionID: "s-root",
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "a", id: "t" } },
      fields: [
        {
          key: "q0",
          type: "string",
          title: "Indent",
          description: "Tabs or spaces?",
          options: [{ value: "Tabs", label: "Tabs" }],
        },
        {
          key: "q1",
          type: "multiselect",
          title: "Features",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      ],
    },
  });
  h.event("form.replied", { id: "f", answer: { q0: "Tabs", q1: ["a", "b"] } });
  expect(Object.values(h.view.interactions)[0]?.resolution).toEqual({
    kind: "question",
    answers: { q0: ["Tabs"], q1: ["a", "b"] },
  });
  h.event("form.created", {
    form: {
      id: "dismiss",
      sessionID: "s-root",
      title: "Questions",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", title: "Question" }],
    },
  });
  h.event("form.cancelled", { id: "dismiss" });
  expect(Object.values(h.view.interactions).at(-1)?.resolution).toMatchObject({
    kind: "question",
    dismissed: true,
  });
});
it("generic forms retain typed fields instead of being flattened into questions", () => {
  const h = setup();
  h.event("form.created", {
    form: {
      id: "generic",
      sessionID: "s-root",
      title: "Age",
      fields: [{ key: "age", type: "number", min: 18 }],
    },
  });
  expect(Object.values(h.view.interactions)[0]?.request).toMatchObject({
    kind: "elicitation",
    schema: { fields: [{ key: "age", type: "number", min: 18 }] },
  });
});
it("transport disconnection preserves pending interactions until authoritative reconciliation", () => {
  const h = setup();
  h.event("permission.asked", { id: "ask", action: "edit", resources: ["x"] });
  h.frame("lifecycle", { type: "disconnected" }, "note");
  expect(Object.values(h.view.interactions)[0]?.state).toBe("pending");
  h.frame("snapshot.interactions", { sessionID: "s-root", keys: [] });
  expect(Object.values(h.view.interactions)[0]?.state).toBe("expired");
});
it("full projected text reconciles deltas without appending them a second time", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.text.started", { assistantMessageID: "a", ordinal: 0 });
  h.event("session.text.delta", { assistantMessageID: "a", ordinal: 0, delta: "hello" });
  h.frame("snapshot.message", {
    sessionID: "s-root",
    message: {
      id: "a",
      type: "assistant",
      time: { completed: 10 },
      content: [{ type: "text", text: "hello world" }],
    },
  });
  h.event("session.text.ended", { assistantMessageID: "a", ordinal: 0, text: "hello world" });
  const message = Object.values(h.view.items).find((i) => i.type === "message");
  expect(message?.type === "message" && message.parts).toEqual([
    { type: "text", text: "hello world" },
  ]);
});
it("durable fork prefixes establish a baseline and old terminal replay cannot end a new run", () => {
  const h = setup();
  h.event(
    "session.execution.started",
    {},
    { durable: { aggregateID: "s-root", seq: 200, version: 1 } },
  );
  h.event(
    "session.execution.succeeded",
    {},
    { durable: { aggregateID: "s-root", seq: 201, version: 1 } },
  );
  h.event(
    "session.execution.started",
    {},
    { durable: { aggregateID: "s-root", seq: 202, version: 1 } },
  );
  h.event(
    "session.execution.succeeded",
    {},
    { durable: { aggregateID: "s-root", seq: 201, version: 1 } },
  );
  expect(h.view.thread.status.state).toBe("working");
  expect(Object.values(h.view.runs)).toHaveLength(2);
});
it("comment-only transport activity keeps liveness without creating a model turn", () => {
  const h = setup();
  h.frame("transport.activity", {}, "note");
  expect(Object.values(h.view.runs)).toHaveLength(0);
  expect(h.view.thread.status.state).toBe("new");
});

it("recovered synthetic completion cannot resurrect a historical background child", () => {
  const h = setup();
  // Ancestry alone cannot prove a child idle. Establish terminal execution evidence.
  h.event("session.execution.started");
  h.event("session.created", {
    sessionID: "child",
    parentID: "s-root",
    projectID: "p",
    location: { directory: "/one" },
  });
  h.event("session.execution.started", { sessionID: "child" });
  h.event("session.execution.succeeded", { sessionID: "child" });
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
  h.frame("snapshot.message", {
    sessionID: "s-root",
    message: {
      id: "wake",
      time: { created: 10 },
      type: "synthetic",
      text: "finished",
      metadata: { source: "subagent", childID: "child", state: "completed" },
    },
  });
  h.frame("snapshot.message", {
    sessionID: "s-root",
    message: {
      id: "old",
      type: "assistant",
      time: { completed: 2 },
      content: [
        {
          type: "tool",
          id: "t",
          name: "subagent",
          time: { created: 1 },
          state: {
            status: "completed",
            input: { background: true },
            content: [{ type: "text", text: "started" }],
            metadata: { sessionID: "child", status: "running" },
          },
        },
      ],
    },
  });
  expect(Object.values(h.view.backgroundTasks).filter((t) => t.status === "running")).toEqual([]);
  expect(h.view.thread.status.state).toBe("done");
});

it("an old idle outcome cannot finish a newer execution observed before disconnect", () => {
  const h = setup();
  h.frame("snapshot.info", {
    info: {
      id: "s-root",
      projectID: "p",
      location: { directory: "/one" },
      outcome: "succeeded",
      time: { idle: 20 },
    },
  });
  h.event("session.execution.started", {}, { created: 30 });
  h.frame("lifecycle", { type: "disconnected" }, "note");
  h.frame("snapshot.info", {
    info: {
      id: "s-root",
      projectID: "p",
      location: { directory: "/one" },
      outcome: "succeeded",
      time: { idle: 20 },
    },
  });
  h.frame("snapshot.active", {
    sessionID: "s-root",
    running: false,
    idleAt: 20,
    outcome: "succeeded",
  });
  h.frame("lifecycle", { type: "resynced" }, "note");
  expect(h.view.thread.status.state).toBe("working");
  h.frame("snapshot.info", {
    info: {
      id: "s-root",
      projectID: "p",
      location: { directory: "/one" },
      outcome: "succeeded",
      time: { idle: 40 },
    },
  });
  expect(h.view.thread.status.state).toBe("done");
  expect(Object.values(h.view.runs)).toHaveLength(1);
});

it("a later background dispatch to the same child waits for its own completion", () => {
  const h = setup();
  h.event("session.created", {
    sessionID: "child",
    parentID: "s-root",
    projectID: "p",
    location: { directory: "/one" },
  });
  const dispatch = (id: string) => {
    h.event("session.execution.started");
    h.event("session.tool.called", {
      assistantMessageID: "a",
      id,
      name: "subagent",
      input: { background: true },
    });
    h.event("session.tool.success", {
      assistantMessageID: "a",
      id,
      metadata: { sessionID: "child", status: "running" },
    });
    h.event("session.execution.started", { sessionID: "child" });
    h.event("session.execution.succeeded");
    expect(h.view.thread.status.state).toBe("working");
    h.event("session.execution.succeeded", { sessionID: "child" });
  };
  dispatch("first");
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  h.event("session.synthetic", {
    metadata: { source: "subagent", childID: "child", state: "completed" },
  });
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  dispatch("continuation");
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  h.frame("snapshot.message", {
    sessionID: "s-root",
    message: {
      id: "old-wake",
      type: "synthetic",
      time: { created: 6 },
      metadata: { source: "subagent", childID: "child", state: "completed" },
    },
  });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  h.event("session.synthetic", {
    metadata: { source: "subagent", childID: "child", state: "completed" },
  });
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
});

it("native synthetic inbox delivery completes background children before parent settlement", () => {
  const h = setup();
  h.event("session.created", {
    sessionID: "child",
    parentID: "s-root",
    projectID: "p",
    location: { directory: "/one" },
  });
  h.event("session.execution.started");
  h.event("session.execution.started", { sessionID: "child" });
  h.event("session.tool.input.started", {
    assistantMessageID: "m",
    id: "delegate",
    name: "subagent",
  });
  h.event("session.tool.called", {
    assistantMessageID: "m",
    id: "delegate",
    input: { background: true, agent: "general" },
  });
  h.event("session.tool.success", {
    assistantMessageID: "m",
    id: "delegate",
    metadata: { sessionID: "child", status: "running" },
  });
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("working");
  h.event("session.execution.succeeded", { sessionID: "child" });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  h.event("session.inbox.enqueued", {
    inboxID: "result",
    item: {
      type: "synthetic",
      payload: {
        metadata: { source: "subagent", childID: "child", state: "completed" },
        text: "summary",
      },
    },
  });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "queue" });
  h.event("session.inbox.delivered", { inboxID: "result" });
  expect(h.view.thread.status.state).toBe("working");
  h.event("session.execution.started");
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
  expect(Object.values(h.view.backgroundTasks).every((task) => task.status === "completed")).toBe(
    true,
  );
});

it("a synthetic shell result consumed in an active execution clears its completion wake", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("shell.created", {
    info: { id: "shell-1", status: "running", metadata: { sessionID: "s-root" } },
  });
  h.event("session.tool.input.started", {
    assistantMessageID: "m",
    id: "shell-call",
    name: "shell",
  });
  h.event("session.tool.called", {
    assistantMessageID: "m",
    id: "shell-call",
    input: { command: "sleep 15", background: true },
  });
  h.event("session.tool.success", {
    assistantMessageID: "m",
    id: "shell-call",
    metadata: { shellID: "shell-1", status: "running" },
  });
  h.event("shell.exited", { id: "shell-1", exit: 0 });
  h.event("session.inbox.enqueued", {
    inboxID: "shell-result",
    item: {
      type: "synthetic",
      payload: { metadata: { source: "shell", shellID: "shell-1", state: "completed" } },
    },
  });
  h.event("session.inbox.delivered", { inboxID: "shell-result" });
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
  expect(h.translator.isSettled()).toBe(true);
});

it("unknown projected content stays diagnostic and malformed live data reports uncertain execution", () => {
  const h = setup();
  const message = {
    id: "future",
    type: "assistant",
    content: [{ type: "future_block", opaque: 42 }],
  };
  h.frame("snapshot.message", { sessionID: "s-root", message });
  expect(Object.values(h.view.items).filter((item) => item.type === "notice")).toEqual([]);
  expect(h.translator.takeDiagnostics()).toMatchObject([{ data: { message } }]);
  const invalid = {
    id: "bad",
    type: "session.execution.started",
    data: null,
    api_key: "synthetic-secret",
  };
  h.frame("sse", invalid);
  expect(Object.values(h.view.items).filter((item) => item.type === "notice")).toMatchObject([
    {
      text: "OpenCode data could not be translated; execution remains uncertain",
      level: "error",
      raw: [{ data: { api_key: "[redacted]" } }],
    },
  ]);
  expect(h.translator.takeDiagnostics()).toEqual([
    { type: "session.execution.started", data: invalid },
  ]);
  expect(h.view.thread.status.state).not.toBe("done");
});

// Mutation: discard snapshot diagnostics or put unsanitized diagnostic data in a notice.
// Not executed (tests run at merge).
it("cumulative snapshots retain full diagnostic receipts and sanitize canonical evidence", () => {
  const h = setup();
  for (const size of [4096, 65536, 262144]) {
    const message = {
      id: "snapshot-user",
      type: "user",
      text: "x".repeat(size),
      api_key: "synthetic-secret",
      futureMetadata: { retained: size },
    };
    const receipt = { sessionID: "s-root", message, futureEnvelope: { retained: size } };
    h.frame("snapshot.message", receipt);
    expect(h.translator.takeDiagnostics()).toEqual([{ type: "snapshot.message", data: receipt }]);
    expect(h.translator.takeDiagnostics()).toEqual([]);
    const item = Object.values(h.view.items).find(
      (entry) => entry.type === "message" && entry.nativeId === "snapshot-user",
    );
    expect(item).toMatchObject({
      parts: [{ type: "text", text: message.text }],
      raw: [{ data: { api_key: "[redacted]", futureMetadata: { retained: size } } }],
    });
    expect(Object.values(h.view.items).filter((entry) => entry.type === "notice")).toEqual([]);
  }
});

it("model socket retries show network waiting while MCP failures remain tool errors", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.tool.failed", {
    id: "call",
    assistantMessageID: "message",
    name: "ace_ace_thread_info",
    error: { message: "MCP transport closed" },
  });
  expect(h.view.thread.status.state).toBe("working");
  expect(
    h.events.some(
      (event) =>
        event.type === "agent.status" &&
        event.status.state === "blocked" &&
        event.status.on === "network",
    ),
  ).toBe(false);
  h.event("session.retry.scheduled", {
    attempt: 2,
    at: 10_000,
    error: { message: "ECONNRESET: The socket connection was closed unexpectedly." },
  });
  expect(h.view.thread.status).toMatchObject({ state: "waiting", on: "network" });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "agent.status",
      status: expect.objectContaining({ state: "blocked", on: "network", attempt: 2 }),
    }),
  );
});

it("a native network retry stops blocking the agent when the same execution produces new work", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.retry.scheduled", {
    attempt: 2,
    at: 2000,
    error: { message: "ECONNRESET: The socket connection was closed unexpectedly" },
  });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "network" });
  h.event("session.text.delta", { assistantMessageID: "resumed", ordinal: 0, delta: "Recovered" });
  expect(h.view.thread.status.state).toBe("working");
  expect(Object.values(h.view.agents)[0]?.status.state).toBe("working");
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
});

it("recorded OpenCode tool progress clears a recovered network retry without declaring the thread done", () => {
  const fixture = z
    .object({
      retry: z.object({ attempt: z.number(), until: z.number(), message: z.string() }),
      progress: z.record(z.string(), z.unknown()),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("./__fixtures__/owner-network-recovery.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const h = setup();
  h.event("session.execution.started");
  h.event("session.retry.scheduled", {
    attempt: fixture.retry.attempt,
    at: fixture.retry.until,
    error: { message: fixture.retry.message },
  });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "network" });
  h.frame("transport.activity", {});
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "network" });
  h.frame("sse", fixture.progress);
  expect(h.view.thread.status.state).toBe("working");
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).not.toBe("done");
  h.event("session.tool.success", {
    assistantMessageID: "resumed-message",
    id: "resumed-tool",
    name: "shell",
    content: [],
  });
  expect(h.view.thread.status.state).toBe("done");
});

it("retry heartbeats, new request metadata and unknown events do not claim that upstream work recovered", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.retry.scheduled", { attempt: 1, at: 2000, error: { message: "ECONNRESET" } });
  h.frame("transport.activity", {});
  h.event("session.model.selected", { model: { providerID: "local", id: "model" } });
  h.event("session.step.started");
  h.event("session.text.future");
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "network" });
  h.event("session.step.streamed");
  expect(h.view.thread.status.state).toBe("working");
});

it("new OpenCode text clears overload retries while quota blocks require explicit quota recovery", () => {
  for (const [message, on] of [
    ["upstream overloaded", "upstream"],
    ["429 quota exhausted", "rate_limit"],
  ] as const) {
    const h = setup();
    h.event("session.execution.started");
    h.event("session.retry.scheduled", { attempt: 1, at: 2000, error: { message } });
    expect(h.view.thread.status).toEqual(
      on === "upstream" ? { state: "waiting", on } : { state: "limited", until: 2001 },
    );
    h.event("session.text.delta", { assistantMessageID: "resumed", ordinal: 0, delta: "Progress" });
    expect(h.view.thread.status).toMatchObject(
      on === "upstream" ? { state: "working" } : { state: "limited", until: 2001 },
    );
  }
});

it("OpenCode system tool schemas never appear as an assistant response while user messages remain visible", () => {
  const h = setup();
  h.frame("snapshot.message", {
    sessionID: "s-root",
    message: {
      id: "system",
      type: "system",
      text: "INTERNAL TOOL SCHEMAS " + "schema ".repeat(25000),
    },
  });
  h.frame("snapshot.message", {
    sessionID: "s-root",
    message: { id: "user", type: "user", text: "Hello" },
  });
  const messages = Object.values(h.view.items).filter((item) => item.type === "message");
  expect(messages).toMatchObject([{ role: "user", parts: [{ type: "text", text: "Hello" }] }]);
});
