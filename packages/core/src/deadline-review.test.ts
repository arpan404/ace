import { ThreadId } from "@ace/protocol";
import { expect, it } from "vitest";
import { apply, createThreadState, nextDeadline } from "./index.ts";
import { harness } from "./test-helper.ts";

it("schedules staggered nested wakes with linear agent reads and settles the tree at the final wake", () => {
  for (const count of [40, 80, 160]) {
    let sequence = 0;
    const state = createThreadState({
      threadId: ThreadId.parse("t"),
      config: { provider: "codex", silenceMs: 10 },
    });
    const ctx = { now: 100, ids: { next: (kind: string) => `${kind}-${++sequence}` } };
    apply(state, { type: "turn.started", agent: "root", trigger: "user" }, ctx);
    apply(state, { type: "turn.ended", agent: "root", outcome: "completed" }, ctx);
    let parent = "root";
    for (let index = 0; index < count; index++) {
      const agent = `child-${index}`;
      apply(
        state,
        {
          type: "agent.seen",
          agent,
          parent,
          origin: "provider_subagent",
          native: { provider: "codex" },
          fidelity: "full",
          cwd: "/repo",
        },
        ctx,
      );
      apply(state, { type: "turn.started", agent, trigger: "spawn" }, ctx);
      apply(state, { type: "turn.ended", agent, outcome: "completed" }, ctx);
      apply(state, { type: "wake.expected", agent, until: 200 + index }, ctx);
      parent = agent;
    }
    let reads = 0;
    state.agents = new Proxy(state.agents, {
      get(target, key, receiver) {
        if (typeof key === "string" && Object.hasOwn(target, key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(nextDeadline(state)).toBe(200);
    expect(reads).toBeLessThanOrEqual(12 * (count + 1));
    reads = 0;
    expect(nextDeadline(state, 150)).toBe(150);
    expect(reads).toBeLessThanOrEqual(12 * (count + 1));
    reads = 0;
    expect(nextDeadline(state, 300)).toBe(200);
    expect(reads).toBeLessThanOrEqual(12 * (count + 1));
    apply(state, { type: "tick" }, { ...ctx, now: 200 });
    reads = 0;
    expect(nextDeadline(state)).toBe(201);
    expect(reads).toBeLessThanOrEqual(12 * (count + 1));
    expect(apply(state, { type: "tick" }, { ...ctx, now: 199 + count })).toContainEqual({
      type: "thread.updated",
      status: { state: "done" },
    });
    expect(nextDeadline(state)).toBeUndefined();
  }
});

it("provider deadlines schedule startup without agents and ignore invalid instants", () => {
  const state = createThreadState({
    threadId: ThreadId.parse("t"),
    config: { provider: "claude", silenceMs: 10 },
  });
  expect(nextDeadline(state)).toBeUndefined();
  expect(nextDeadline(state, 0)).toBe(0);
  expect(nextDeadline(state, 150)).toBe(150);
  for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(nextDeadline(state, invalid)).toBeUndefined();
});

it("provider maintenance survives live tools and competes with silence until process exit", () => {
  const h = harness("claude", { silenceMs: 10 });
  h.start();
  h.shell();
  expect(nextDeadline(h.state)).toBeUndefined();
  expect(nextDeadline(h.state, 150)).toBe(150);
  h.send({ type: "turn.started", agent: "quiet", trigger: "user" }, 110);
  expect(nextDeadline(h.state, 130)).toBe(121);
  expect(nextDeadline(h.state, 120)).toBe(120);
  h.send({ type: "process.exited", deliberate: true }, 200);
  expect(nextDeadline(h.state, 0)).toBeUndefined();
});

it("groups live work once even when every sibling has a distinct silence candidate", () => {
  for (const count of [20, 40, 80, 160]) {
    let sequence = 0;
    const state = createThreadState({
      threadId: ThreadId.parse("t"),
      config: { provider: "codex", silenceMs: 10 },
    });
    const ids = { next: (kind: string) => `${kind}-${++sequence}` };
    apply(state, { type: "turn.started", agent: "root", trigger: "user" }, { now: 100, ids });
    for (let index = 0; index < count; index++) {
      const ctx = { now: 100 + index, ids };
      const agent = `child-${index}`;
      apply(state, { type: "turn.started", agent, trigger: "spawn" }, ctx);
      apply(
        state,
        { type: "item.delta", agent, item: `shell-${index}`, field: "output", append: "running" },
        ctx,
      );
    }
    let reads = 0;
    state.items = new Proxy(state.items, {
      get(target, key, receiver) {
        if (typeof key === "string" && Object.hasOwn(target, key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(nextDeadline(state)).toBeUndefined();
    expect(reads).toBeLessThanOrEqual(count * 3);
    apply(
      state,
      { type: "turn.started", agent: "quiet", trigger: "user" },
      { now: 100 + count, ids },
    );
    reads = 0;
    expect(nextDeadline(state)).toBe(111 + count);
    expect(reads).toBeLessThanOrEqual(count * 3);
  }
});

it("schedules the last child wake before an active parent's suppressed silence", () => {
  const h = harness("codex", { silenceMs: 10 });
  h.start();
  h.see("child", "root");
  h.start("child");
  h.end("child");
  h.send({ type: "wake.expected", agent: "child", until: 200 }, 110);
  expect(nextDeadline(h.state)).toBe(200);
  expect(h.send({ type: "tick" }, 200)).toContainEqual({
    type: "thread.updated",
    status: { state: "unresponsive" },
  });
  expect(h.agent("child")?.status).toEqual({ state: "idle" });
  expect(h.agent("root")?.status).toEqual({ state: "unresponsive", lastSignalAt: 110 });
  expect(nextDeadline(h.state)).toBeUndefined();
});

it("a never-started child's wake grace expires before its suppressed silence timer", () => {
  const h = harness("codex", { silenceMs: 10 });
  h.start();
  h.end();
  h.see("child", "root");
  h.send({ type: "wake.expected", agent: "child", until: 200 }, 110);
  expect(nextDeadline(h.state)).toBe(200);
  expect(h.send({ type: "tick" }, 200)).toContainEqual({
    type: "thread.updated",
    status: { state: "done" },
  });
  expect(h.agent("child")?.status).toEqual({ state: "unresponsive", lastSignalAt: 110 });
  expect(nextDeadline(h.state)).toBeUndefined();
});

it("an expired initial-root wake does not schedule a silence tick before the first run", () => {
  const h = harness("codex", { silenceMs: 10 });
  h.see();
  h.send({ type: "wake.expected", agent: "root", until: 200 }, 110);
  expect(nextDeadline(h.state)).toBe(200);
  h.send({ type: "tick" }, 200);
  expect(h.agent("root")?.status).toEqual({ state: "starting" });
  expect(h.view.status).toEqual({ state: "new" });
  expect(nextDeadline(h.state)).toBeUndefined();
});

it("a settled startup failure does not preempt a restarted child's silence deadline", () => {
  const h = harness("codex", { silenceMs: 10 });
  h.see();
  h.send({ type: "process.exited", deliberate: false });
  h.send({ type: "process.started" });
  h.start("child");
  h.send({ type: "signal", agent: "child" }, 200);
  expect(h.agent("root")?.status.state).toBe("failed");
  expect(nextDeadline(h.state)).toBe(211);
  h.send({ type: "tick" }, 211);
  expect(h.agent("child")?.status).toEqual({ state: "unresponsive", lastSignalAt: 200 });
  expect(nextDeadline(h.state)).toBeUndefined();
});

it("incremental deadlines preserve independent siblings and schedule their unresponsive transitions", async () => {
  const { DeadlineIndex } = await import("./index.ts");
  const h = harness("codex", { silenceMs: 100 });
  h.send({ type: "turn.started", agent: "root", trigger: "user" }, 100);
  for (const agent of ["a", "b"]) {
    h.send(
      {
        type: "agent.seen",
        agent,
        parent: "root",
        origin: "provider_subagent",
        native: { provider: "codex" },
        fidelity: "full",
        cwd: "/repo",
      },
      100,
    );
    h.send({ type: "turn.started", agent, trigger: "spawn" }, 100);
    h.send({ type: "item.delta", agent, item: agent, field: "text", append: "seed" }, 100);
  }
  const index = new DeadlineIndex(h.state);
  h.send({ type: "item.delta", agent: "a", item: "a", field: "text", append: "next" }, 150);
  index.signal("a", 150, 100);
  expect(index.next()).toBe(201);
  h.send({ type: "item.delta", agent: "b", item: "b", field: "text", append: "next" }, 160);
  index.signal("b", 160, 100);
  expect(index.next()).toBe(251);
  h.send({ type: "tick" }, 251);
  expect(h.agent("a")?.status.state).toBe("unresponsive");
  expect(h.agent("b")?.status.state).toBe("working");
  index.rebuild(h.state);
  expect(index.next()).toBe(261);
});
