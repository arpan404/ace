import { expect, it } from "vitest";
import { nextDeadline } from "./index.ts";
import { harness } from "./test-helper.ts";

it("a successful root turn recovers the thread from an older child failure", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("child", "root");
  h.start("child");
  h.end("child", "failed");
  h.end();
  expect(h.view.status).toEqual({ state: "done" });
  expect(h.agent("child")!.status.state).toBe("failed");
  h.start("root", "recover");
  h.end();
  expect(h.view.status).toEqual({ state: "done" });
});

it("a child failure newer than the root success fails the settled thread until recovery", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("child", "root", true);
  h.start("child");
  h.end();
  h.end("child", "failed");
  expect(h.view.status).toEqual({ state: "failed" });
  h.start("root", "recover");
  h.end();
  expect(h.view.status).toEqual({ state: "done" });
});

it("a never-started silent placeholder becomes unresponsive instead of keeping the thread working", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.end();
  h.send({ type: "usage", agent: "stray", inputTokens: 1, outputTokens: 0 }, 200);
  expect(h.view.status.state).toBe("working");
  h.send({ type: "tick" }, 301);
  expect(h.agent("stray")!.status).toEqual({ state: "unresponsive", lastSignalAt: 200 });
  expect(h.agent("root")!.status).toEqual({ state: "idle" });
  expect(h.view.status).toEqual({ state: "done" });
  h.start("root", "recovery");
  h.end();
  expect(h.view.status).toEqual({ state: "done" });
  expect(h.agent("stray")!.status).toEqual({ state: "unresponsive", lastSignalAt: 200 });
});

it("a silent child with an active run still holds completion after the root ends", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.see("child", "root", true);
  h.start("child");
  h.end();
  h.send({ type: "tick" }, 300);
  expect(h.agent("child")!.status.state).toBe("unresponsive");
  expect(h.agent("root")!.status).toEqual({
    state: "blocked",
    on: "background_task",
    refs: [h.agent("child")!.id],
  });
  expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  h.end("child");
  expect(h.view.status).toEqual({ state: "done" });
});

it("a silent never-started child with a live shell still holds completion", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.see("child", "root", true);
  h.shell("shell", "child");
  h.background("task", "shell", "child");
  h.end();
  h.send({ type: "tick" }, 300);
  expect(h.agent("child")!.status.state).toBe("unresponsive");
  expect(h.agent("root")!.status).toEqual({
    state: "blocked",
    on: "background_task",
    refs: [h.agent("child")!.id],
  });
  expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  h.send({ type: "background.ended", task: "task", status: "completed" });
  h.send({
    type: "item.upsert",
    agent: "child",
    item: "shell",
    draft: {
      type: "tool_call",
      call: { status: "succeeded" },
    },
  });
  h.send({ type: "tick" }, 403);
  expect(h.view.status).toEqual({ state: "done" });
});

it("a never-started unresponsive child with a live tool still holds completion", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.shell("tool", "stray");
  h.end();
  h.send({ type: "tick" }, 300);
  expect(h.agent("stray")!.status.state).toBe("unresponsive");
  expect(h.agent("root")!.status).toMatchObject({ state: "blocked", on: "background_task" });
  expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  h.send({
    type: "item.upsert",
    agent: "stray",
    item: "tool",
    draft: {
      type: "tool_call",
      call: { status: "succeeded" },
    },
  });
  h.send({ type: "tick" }, 402);
  expect(h.view.status).toEqual({ state: "done" });
});

it("a never-started silent parent still holds completion while its descendant has a run", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.see("stray", "root", true);
  h.see("grandchild", "stray", true);
  h.start("grandchild");
  h.end();
  h.send({ type: "tick" }, 300);
  expect(h.agent("stray")!.status.state).toBe("unresponsive");
  expect(h.agent("grandchild")!.status.state).toBe("unresponsive");
  expect(h.agent("root")!.status).toEqual({
    state: "blocked",
    on: "background_task",
    refs: [h.agent("stray")!.id],
  });
  expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  h.end("grandchild");
  h.send({ type: "tick" }, 402);
  expect(h.view.status).toEqual({ state: "done" });
});

it("a never-started child with a pending question still requires the human after silence", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.question("question", "stray");
  h.end();
  h.send({ type: "tick" }, 300);
  expect(h.agent("root")!.status).toEqual({
    state: "blocked",
    on: "background_task",
    refs: [h.agent("stray")!.id],
  });
  expect(h.view.status).toEqual({ state: "needs_you", interactions: 1 });
});

it("a never-started child in retry still waits on the provider after silence", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.send({ type: "retry", agent: "stray", on: "upstream" });
  h.end();
  h.send({ type: "tick" }, 300);
  expect(h.agent("root")!.status).toEqual({
    state: "blocked",
    on: "background_task",
    refs: [h.agent("stray")!.id],
  });
  expect(h.view.status).toEqual({ state: "waiting", on: "upstream" });
});

it("a never-started child becomes unresponsive when its spawning tool finishes", () => {
  const h = harness();
  h.see();
  h.start();
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "spawn",
    draft: {
      type: "tool_call",
      call: {
        kind: "agent.spawn",
        status: "running",
        detail: { kind: "agent.spawn", childAgent: "child" },
      },
    },
  });
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "spawn",
    draft: { type: "tool_call", call: { status: "succeeded" } },
  });
  expect(h.agent("child")!.status.state).toBe("unresponsive");
  h.end();
  expect(h.agent("root")!.status).toEqual({ state: "idle" });
  expect(h.view.status).toEqual({ state: "done" });
});

it("a configured root stays new before its first turn", () => {
  const h = harness(
    "codex",
    { silenceMs: 100 },
    {
      agent: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/repo",
    },
  );
  const events = h.send({ type: "queue.changed", count: 0 }, 100);
  expect(events.filter((event) => event.type === "thread.updated")).toEqual([]);
  expect(h.view.status).toEqual({ state: "new" });
});

it("a root's own response stays working while a background child is live", () => {
  const h = harness("claude");
  h.see();
  h.start();
  h.see("child", "root", true);
  h.start("child");
  h.send({ type: "activity", agent: "root", activity: "responding" });
  expect(h.agent("root")!.status).toEqual({ state: "working", activity: "responding" });
  expect(h.view.status.state).toBe("working");
});

it("silence scheduling returns the first instant past the silence threshold", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.send({ type: "signal", agent: "root" }, 200);
  expect(nextDeadline(h.state)).toBe(301);
  h.send({ type: "tick" }, 300);
  expect(h.agent("root")!.status.state).toBe("working");
  h.send({ type: "tick" }, nextDeadline(h.state)!);
  expect(h.agent("root")!.status).toEqual({ state: "unresponsive", lastSignalAt: 200 });
  expect(nextDeadline(h.state)).toBeUndefined();
});

it("wake scheduling chooses expiry before later silence thresholds", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.end();
  h.send({ type: "wake.expected", agent: "root", until: 200 }, 150);
  h.see("child", "root");
  expect(nextDeadline(h.state)).toBe(200);
  h.send({ type: "tick" }, 200);
  expect(h.agent("root")!.status).toMatchObject({ state: "blocked", on: "background_task" });
  expect(nextDeadline(h.state)).toBe(252);
});

it("tools and approvals do not schedule agent-silence ticks but transport silence still does", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.shell();
  h.question();
  expect(nextDeadline(h.state)).toBeUndefined();
  const transport = harness("codex", { silenceMs: 100, liveness: "transport" });
  transport.see();
  transport.start();
  transport.shell();
  transport.send({ type: "signal" }, 200);
  expect(nextDeadline(transport.state)).toBe(301);
  transport.send({ type: "tick" }, 301);
  expect(transport.agent("root")!.status.state).toBe("unresponsive");
  transport.send({ type: "process.exited", deliberate: false });
  expect(nextDeadline(transport.state)).toBeUndefined();
});

it("placeholders use the configured provider before a real root is seen", () => {
  const h = harness("cursor");
  h.send({ type: "usage", agent: "early", inputTokens: 1, outputTokens: 0 });
  expect(h.agent("early")!.native.provider).toBe("cursor");
});

it("a configured idle root remains new without scheduling silence before any turn", () => {
  const h = harness(
    "codex",
    { silenceMs: 100 },
    {
      agent: "root",
      fidelity: "full",
      native: { provider: "codex", nativeId: "root" },
      cwd: "/repo",
    },
  );
  h.send({ type: "tick" }, 100);
  expect(nextDeadline(h.state)).toBeUndefined();
  h.send({ type: "tick" }, 10_000);
  expect(h.view.status).toEqual({ state: "new" });
});

it("same-timestamp root recovery wins over a preceding child failure and survives a later interrupt", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("child", "root");
  h.start("child");
  h.send({ type: "turn.ended", agent: "child", outcome: "failed" }, 200);
  h.send({ type: "turn.ended", agent: "root", outcome: "completed" }, 200);
  expect(h.view.status).toEqual({ state: "done" });
  h.start("root", "later");
  h.end("root", "interrupted");
  expect(h.view.status).toEqual({ state: "done" });
  expect(h.agent("child")!.status.state).toBe("failed");
});

it("a later child success does not clear the root's latest failed outcome", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("child", "root");
  h.start("child");
  h.end("root", "failed");
  h.end("child");
  expect(h.view.status).toEqual({ state: "failed" });
  expect(h.agent("root")!.status.state).toBe("failed");
});

it("fractional silence thresholds still schedule a valid integer tick", () => {
  const h = harness("codex", { silenceMs: 0.5 });
  h.see();
  h.start();
  h.send({ type: "signal", agent: "root" }, 200);
  expect(nextDeadline(h.state)).toBe(201);
  h.send({ type: "tick" }, nextDeadline(h.state)!);
  expect(h.agent("root")!.status.state).toBe("unresponsive");
});

it("a settled child's recent signal postpones the active parent's silence timer", () => {
  const h = harness("codex", { silenceMs: 100 });
  h.see();
  h.start();
  h.see("child", "root");
  h.start("child");
  h.end("child");
  h.send({ type: "signal", agent: "child" }, 200);
  expect(nextDeadline(h.state)).toBe(301);
  h.send({ type: "tick" }, nextDeadline(h.state)!);
  expect(h.agent("root")!.status).toEqual({ state: "unresponsive", lastSignalAt: 200 });
});

it("a recovered process's end-only completed turn clears a prior startup failure", () => {
  const h = harness();
  h.see();
  h.send({ type: "process.exited", deliberate: false });
  h.send({ type: "process.started" });
  const events = h.send({
    type: "turn.ended",
    agent: "root",
    nativeTurnId: "resumed-final",
    outcome: "completed",
  });
  expect(events).toContainEqual(expect.objectContaining({ type: "run.ended", state: "completed" }));
  expect(h.agent("root")!.status).toEqual({ state: "idle" });
  expect(h.view.status).toEqual({ state: "done" });
});

it("a child remains linked when its spawning item's kind is identified after its first upsert", () => {
  const h = harness();
  h.see();
  h.start();
  h.see("child", "root");
  h.start("child");
  h.send({ type: "agent.linked", agent: "child", spawnedBy: "spawn" });
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "spawn",
    draft: { type: "tool_call", call: { status: "running" } },
  });
  const events = h.send({
    type: "item.upsert",
    agent: "root",
    item: "spawn",
    draft: { type: "tool_call", call: { kind: "agent.spawn", detail: { kind: "agent.spawn" } } },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "item.updated",
      item: expect.objectContaining({
        call: expect.objectContaining({
          detail: { kind: "agent.spawn", childAgentId: h.agent("child")!.id },
        }),
      }),
    }),
  );
  expect(h.agent("root")!.status).toEqual({
    state: "blocked",
    on: "subagents",
    refs: [h.agent("child")!.id],
  });
});
