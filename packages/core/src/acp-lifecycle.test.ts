import { it, expect } from "vitest";
import { ThreadId } from "@ace/protocol";
import { apply, createThreadState, type Fact } from "./index.ts";
function setup() {
  const state = createThreadState({
    threadId: ThreadId.parse("acp-contract"),
    config: { provider: "cursor", silenceMs: 90_000 },
  });
  let time = 0;
  let ids = 0;
  const send = (fact: Fact) =>
    apply(state, fact, { now: ++time, ids: { next: () => `id-${++ids}` } });
  send({
    type: "agent.seen",
    agent: "root",
    origin: "root",
    fidelity: "full",
    native: { provider: "cursor" },
    cwd: "/work",
  });
  send({ type: "turn.started", agent: "root", trigger: "user" });
  function child() {
    send({
      type: "agent.seen",
      agent: "child",
      parent: "root",
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "cursor" },
      cwd: "/work",
    });
    send({ type: "turn.started", agent: "child", trigger: "spawn" });
    send({ type: "turn.ended", agent: "root", outcome: "completed" });
  }
  function shell() {
    send({
      type: "background.started",
      agent: "root",
      task: "shell",
      kind: "shell",
      title: "Unobserved shell",
      stoppable: false,
    });
  }
  return { state, send, child, shell };
}
it("an explicit child disconnect preserves uncertainty until reconnect", () => {
  const h = setup();
  h.child();
  h.send({ type: "agent.disconnected", agent: "child" });
  expect(h.state.agents["child"]?.agent.status.state).toBe("unresponsive");
  expect(h.state.status.state).toBe("unresponsive");
  h.send({ type: "agent.reconnected", agent: "child" });
  expect(h.state.status.state).toBe("working");
});
it("uncertain unknown shell execution holds completion until explicit terminal evidence", () => {
  const h = setup();
  h.shell();
  h.send({ type: "background.ended", task: "shell", status: "unknown", uncertain: true });
  h.send({ type: "turn.ended", agent: "root", outcome: "interrupted" });
  expect(h.state.tasks["shell"]?.status).toBe("unknown");
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  const events = h.send({ type: "background.ended", task: "shell", status: "completed" });
  expect(events).toContainEqual(
    expect.objectContaining({ type: "background_task.updated", status: "completed" }),
  );
  expect(h.state.status.state).toBe("done");
});
it("unknown tasks without execution uncertainty retain their existing settlement behavior", () => {
  const h = setup();
  h.shell();
  h.send({ type: "background.ended", task: "shell", status: "unknown" });
  h.send({ type: "turn.ended", agent: "root", outcome: "interrupted" });
  expect(h.state.status.state).toBe("done");
});
it("legacy snapshots can receive an uncertain task without a new state migration", () => {
  const h = setup();
  delete h.state.uncertainTasks;
  h.shell();
  h.send({ type: "background.ended", task: "shell", status: "unknown", uncertain: true });
  h.send({ type: "turn.ended", agent: "root", outcome: "interrupted" });
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
});
it("process termination clears connection uncertainty before a later successful root turn", () => {
  const h = setup();
  h.child();
  h.send({ type: "agent.disconnected", agent: "child" });
  h.send({ type: "process.exited", deliberate: false });
  expect(h.state.status.state).toBe("failed");
  h.send({ type: "process.started" });
  h.send({ type: "turn.started", agent: "root", trigger: "user" });
  h.send({ type: "turn.ended", agent: "root", outcome: "completed" });
  expect(h.state.status.state).toBe("done");
});
it("a live background shell takes precedence over a disconnected child", () => {
  const h = setup();
  h.shell();
  h.child();
  h.send({ type: "agent.disconnected", agent: "child" });
  expect(h.state.agents["child"]?.agent.status.state).toBe("unresponsive");
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
});
