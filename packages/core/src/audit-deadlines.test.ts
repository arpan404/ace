import { ThreadId } from "@ace/protocol";
import { expect, it } from "vitest";
import { apply, createThreadState, nextDeadline } from "./index.ts";

it("deadline scheduling visits live shells once per pass as sibling counts grow", () => {
  for (const count of [20, 40, 80]) {
    let sequence = 0;
    const state = createThreadState({
      threadId: ThreadId.parse("t"),
      config: { provider: "codex", silenceMs: 10 },
    });
    const ctx = { now: 100, ids: { next: (kind: string) => `${kind}-${++sequence}` } };
    apply(state, { type: "turn.started", agent: "root", trigger: "user" }, ctx);
    for (let i = 0; i < count; i++) {
      const agent = `child-${i}`;
      apply(
        state,
        {
          type: "agent.seen",
          agent,
          parent: "root",
          origin: "provider_subagent",
          native: { provider: "codex" },
          fidelity: "full",
          cwd: "/repo",
        },
        ctx,
      );
      apply(state, { type: "turn.started", agent, trigger: "spawn" }, ctx);
      apply(
        state,
        { type: "item.delta", agent, item: `shell-${i}`, field: "output", append: "running" },
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
    apply(state, { type: "turn.started", agent: "quiet", trigger: "user" }, ctx);
    expect(nextDeadline(state)).toBe(111);
  }
});

it("evaluates each wake deadline at its own time and schedules the remaining wake after a tick", () => {
  const state = createThreadState({
    threadId: ThreadId.parse("t"),
    config: { provider: "codex", silenceMs: 10 },
  });
  let sequence = 0;
  const ids = { next: (kind: string) => `${kind}-${++sequence}` };
  const send = (input: unknown, now = 100) => apply(state, input, { now, ids });
  send({ type: "turn.started", agent: "root", trigger: "user" });
  send({ type: "turn.ended", agent: "root", outcome: "completed" });
  for (const [agent, until] of [
    ["first", 200],
    ["second", 300],
  ] as const) {
    send({ type: "turn.started", agent, trigger: "spawn" });
    send({ type: "turn.ended", agent, outcome: "completed" });
    send({ type: "wake.expected", agent, until });
  }
  expect(nextDeadline(state)).toBe(200);
  const first = send({ type: "tick" }, 200);
  expect(first).toContainEqual({ type: "thread.updated", status: { state: "working", agents: 1 } });
  expect(nextDeadline(state)).toBe(300);
  expect(send({ type: "tick" }, 300)).toContainEqual({
    type: "thread.updated",
    status: { state: "done" },
  });
  expect(nextDeadline(state)).toBeUndefined();
});
