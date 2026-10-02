import { expect, test } from "vitest";
import { apply, createThreadState, nextDeadline } from "./index.ts";
import { ThreadId, type EventPayload } from "@ace/protocol";
import type { Fact } from "./index.ts";

function harness() {
  const state = createThreadState({
    threadId: ThreadId.parse("contracts"),
    config: { provider: "claude", silenceMs: 60_000 },
    rootAgent: {
      agent: "root",
      fidelity: "full",
      native: { provider: "claude", nativeId: "s" },
      cwd: "/repo",
    },
  });
  let id = 0;
  const events: EventPayload[] = [];
  const send = (fact: Fact, now = 10) =>
    events.push(...apply(state, fact, { now, ids: { next: (k) => `${k}:${++id}` } }));
  send({ type: "turn.started", agent: "root", trigger: "user" }, 1);
  send({ type: "turn.ended", agent: "root", outcome: "completed" }, 2);
  return { state, send, events };
}
test("restarting a provider preserves held engine input and discards its old native queue", () => {
  const h = harness();
  h.send({ type: "queue.changed", count: 2 });
  h.send({ type: "queue.changed", count: 3, source: "provider" });
  expect(h.state.queueCount).toBe(5);
  h.send({ type: "process.exited", deliberate: true });
  h.send({ type: "process.started" });
  expect(h.state.queueCount).toBe(2);
  expect(h.state.status).toEqual({ state: "waiting", on: "queue" });
  h.send({ type: "queue.changed", count: 0 });
  expect(h.state.status.state).toBe("done");
});
test("source queues aggregate independently in either draining order", () => {
  const h = harness();
  h.send({ type: "queue.changed", count: 2, source: "engine" });
  h.send({ type: "queue.changed", count: 3, source: "provider" });
  h.send({ type: "queue.changed", count: 0, source: "engine" });
  expect(h.state.queueCount).toBe(3);
  expect(h.state.status).toEqual({ state: "waiting", on: "queue" });
  h.send({ type: "queue.changed", count: 0, source: "provider" });
  expect(h.state.status.state).toBe("done");
});
test("an invalid queue source cannot discard held engine input", () => {
  const h = harness();
  h.send({ type: "queue.changed", count: 2 });
  const events = apply(
    h.state,
    { type: "queue.changed", count: 0, source: "future" },
    { now: 20, ids: { next: (k) => `invalid:${k}` } },
  );
  expect(h.state.queueCount).toBe(2);
  expect(h.state.status).toEqual({ state: "waiting", on: "queue" });
  expect(events.some((e) => e.type === "item.created" && e.item.type === "notice")).toBe(true);
});
test("provider scheduling uses the earliest live deadline and stops after process exit", () => {
  const h = harness();
  h.send({ type: "wake.expected", agent: "root", until: 5100 }, 100);
  expect(nextDeadline(h.state, 1100)).toBe(1100);
  expect(nextDeadline(h.state, 9000)).toBe(5100);
  expect(nextDeadline(h.state, -1)).toBe(5100);
  h.send({ type: "process.exited", deliberate: true }, 200);
  expect(nextDeadline(h.state, 1100)).toBeUndefined();
});
