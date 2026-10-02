import { describe, expect, it } from "vitest";
import { harness } from "./test-helper.ts";

describe("client-visible agent activity", () => {
  it("an agent-free signal refreshes every agent's default liveness", () => {
    const h = harness("codex", { silenceMs: 100 });
    h.see();
    h.start();
    h.see("child", "root");
    h.start("child");
    h.send({ type: "signal" }, 200);
    h.send({ type: "tick" }, 300);
    expect(h.agent("root")?.status).toMatchObject({ state: "working" });
    expect(h.agent("child")?.status).toMatchObject({ state: "working" });
    h.send({ type: "tick" }, 301);
    expect(h.agent("child")?.status).toEqual({ state: "unresponsive", lastSignalAt: 200 });
  });

  it("a reasoning delta restores an unresponsive agent to working", () => {
    const h = harness("codex", { silenceMs: 100 });
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "reason",
      draft: { type: "reasoning", text: "", complete: false },
    });
    h.send({ type: "item.delta", agent: "root", item: "reason", field: "reasoning", append: "a" });
    h.send({ type: "tick" }, 1000);
    expect(h.agent("root")?.status).toMatchObject({ state: "unresponsive" });
    const recovered = h.send(
      { type: "item.delta", agent: "root", item: "reason", field: "reasoning", append: "b" },
      1001,
    );
    expect(recovered).toContainEqual(
      expect.objectContaining({
        type: "agent.status",
        status: { state: "working", activity: "thinking" },
      }),
    );
    expect(h.view.status).toEqual({ state: "working", agents: 1 });
    expect(h.item("reason")).toMatchObject({ text: "ab" });
  });

  it("agent messages expose a stable target identity before its metadata arrives", () => {
    const h = harness();
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "message",
      draft: {
        type: "tool_call",
        call: {
          kind: "agent.message",
          title: "Tell worker",
          status: "running",
          detail: { kind: "agent.message", targetAgent: "worker" },
        },
      },
    });
    const workerId = h.agent("worker")?.id;
    expect(workerId).toBeDefined();
    expect(h.item("message")).toMatchObject({ call: { detail: { targetAgentId: workerId } } });
    h.see("worker", "root");
    expect(h.agent("worker")).toMatchObject({ id: workerId, fidelity: "full" });
    expect(h.item("message")).toMatchObject({ call: { detail: { targetAgentId: workerId } } });
  });

  it("a background child's spawn tool keeps its parent working rather than waiting on subagents", () => {
    const h = harness();
    h.see();
    h.start();
    h.see("worker", "root", true);
    h.start("worker");
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "spawn",
      draft: {
        type: "tool_call",
        call: {
          kind: "agent.spawn",
          title: "Worker",
          status: "running",
          detail: { kind: "agent.spawn", childAgent: "worker" },
        },
      },
    });
    expect(h.agent("root")?.status).toMatchObject({
      state: "working",
      activity: "tool",
      itemId: h.item("spawn")?.id,
    });
  });

  it("two spawn tools referencing the same child produce one blocking reference", () => {
    const h = harness();
    h.see();
    h.start();
    h.see("worker", "root");
    h.start("worker");
    for (const item of ["spawn-a", "spawn-b"])
      h.send({
        type: "item.upsert",
        agent: "root",
        item,
        draft: {
          type: "tool_call",
          call: {
            kind: "agent.spawn",
            title: "Worker",
            status: "running",
            detail: { kind: "agent.spawn", childAgent: "worker" },
          },
        },
      });
    expect(h.agent("root")?.status).toEqual({
      state: "blocked",
      on: "subagents",
      refs: [h.agent("worker")?.id],
    });
  });

  it("context compaction remains live and exposes the compacting activity", () => {
    const h = harness();
    h.see();
    h.start();
    const events = h.send({ type: "activity", agent: "root", activity: "compacting" });
    expect(events).toContainEqual({
      type: "agent.status",
      agentId: h.agent("root")?.id,
      status: { state: "working", activity: "compacting" },
    });
    expect(h.view.status.state).toBe("working");
    h.end();
    expect(h.view.status).toEqual({ state: "done" });
  });
});
