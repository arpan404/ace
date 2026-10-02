import { describe, expect, it } from "vitest";
import { harness } from "./test-helper.ts";

describe("reused provider identities", () => {
  it("a reused approval key opens a new approval after the first one closes", () => {
    const h = harness();
    h.see();
    h.start();
    const first = h.question("0").find((event) => event.type === "interaction.opened");
    expect(first).toBeDefined();
    h.send({ type: "interaction.closed", interaction: "0", state: "resolved" });
    const reopened = h.question("0");
    const second = reopened.find((event) => event.type === "interaction.opened");
    expect(second).toBeDefined();
    expect(second?.interaction.id).not.toBe(first?.interaction.id);
    expect(second?.interaction.state).toBe("pending");
    expect(reopened).toContainEqual({
      type: "thread.updated",
      status: { state: "needs_you", interactions: 1 },
    });
  });

  it("a reused background key starts new work after the first task finishes", () => {
    const h = harness();
    h.see();
    h.start();
    const first = h.background("0").find((event) => event.type === "background_task.started");
    h.end();
    h.send({ type: "background.ended", task: "0", status: "completed" });
    const restarted = h.background("0");
    const second = restarted.find((event) => event.type === "background_task.started");
    expect(second).toBeDefined();
    expect(second?.task.id).not.toBe(first?.task.id);
    expect(second?.task.status).toBe("running");
    expect(restarted).toContainEqual({
      type: "thread.updated",
      status: { state: "waiting", on: "background_task" },
    });
  });

  it("duplicate opens preserve the first pending approval and running task", () => {
    const h = harness();
    h.see();
    h.start();
    const opened = h.question("0").find((event) => event.type === "interaction.opened");
    const started = h.background("0").find((event) => event.type === "background_task.started");
    expect(h.question("0").filter((event) => event.type === "interaction.opened")).toEqual([]);
    expect(h.background("0").filter((event) => event.type === "background_task.started")).toEqual(
      [],
    );
    const closed = h.send({ type: "interaction.closed", interaction: "0", state: "resolved" });
    expect(closed).toContainEqual(
      expect.objectContaining({
        type: "interaction.closed",
        interactionId: opened?.interaction.id,
      }),
    );
    const ended = h.send({ type: "background.ended", task: "0", status: "completed" });
    expect(ended).toContainEqual(
      expect.objectContaining({
        type: "background_task.updated",
        taskId: started?.task.id,
        status: "completed",
      }),
    );
  });
});

describe("partial and resumed provider lifecycles", () => {
  it("the first provider fact cannot re-parent the configured root under a phantom child", () => {
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
    expect(h.send({ type: "agent.linked", agent: "root", parent: "phantom-child" })).toEqual([]);
    const events = h.send({ type: "queue.changed", count: 0 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.created",
        item: expect.objectContaining({ type: "notice", level: "warning" }),
      }),
    );
    expect(h.agent("root")).toMatchObject({ parentId: null, origin: "root" });
    expect(Object.values(h.view.agents)).toHaveLength(1);
  });
  it("a new native start interrupts the previous run before creating its replacement", () => {
    const h = harness();
    h.see();
    const previous = h.start("root", "first").find((event) => event.type === "run.started");
    h.shell();
    const events = h.start("root", "second");
    expect(
      events.filter((event) => event.type === "run.ended" || event.type === "run.started"),
    ).toMatchObject([
      { type: "run.ended", runId: previous?.run.id, state: "interrupted" },
      { type: "run.started", run: { nativeId: "second", state: "active" } },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.updated",
        item: expect.objectContaining({ call: expect.objectContaining({ status: "cancelled" }) }),
      }),
    );
  });

  it("a missing start is reconstructed before the observed end", () => {
    const h = harness();
    h.see();
    const events = h.send({
      type: "turn.ended",
      agent: "root",
      nativeTurnId: "lost-start",
      outcome: "completed",
      trigger: "subagent_result",
    });
    const started = events.find((event) => event.type === "run.started");
    expect(
      events.filter((event) => event.type === "run.started" || event.type === "run.ended"),
    ).toMatchObject([
      { type: "run.started", run: { nativeId: "lost-start", trigger: "subagent_result" } },
      { type: "run.ended", runId: started?.run.id, state: "completed" },
    ]);
    expect(events).toContainEqual({ type: "thread.updated", status: { state: "done" } });
  });

  it.each(["start", "end"] as const)("a turn %s clears its previous retry", (boundary) => {
    const h = harness();
    h.see();
    if (boundary === "end") h.start();
    h.send({ type: "retry", agent: "root", on: "upstream", attempt: 3 });
    const events = boundary === "start" ? h.start() : h.end();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent.status",
        status:
          boundary === "start"
            ? { state: "working", activity: "starting_turn" }
            : { state: "idle" },
      }),
    );
    expect(events).toContainEqual({
      type: "thread.updated",
      status: boundary === "start" ? { state: "working", agents: 1 } : { state: "done" },
    });
  });

  it("a late trigger correction updates an ended run without ending newer work", () => {
    const h = harness();
    h.see();
    const original = h.start("root", "first").find((event) => event.type === "run.started");
    const firstEnd = h.end().find((event) => event.type === "run.ended");
    h.start("root", "second");
    const events = h.send({
      type: "turn.ended",
      agent: "root",
      nativeTurnId: "first",
      outcome: "completed",
      trigger: "background_completion",
    });
    expect(events).toEqual([
      {
        type: "run.ended",
        runId: original?.run.id,
        state: "completed",
        endedAt: firstEnd?.endedAt,
        trigger: "background_completion",
      },
    ]);
    const end = h.end().find((event) => event.type === "run.ended");
    expect(end?.runId).not.toBe(original?.run.id);
  });

  it("a restarted process can begin new turns on the existing event history", () => {
    const h = harness();
    h.see();
    h.start("root", "before-exit");
    h.question("0");
    h.send({ type: "process.exited", deliberate: false });
    const count = h.history.length;
    h.send({ type: "process.started" });
    const events = h.start("root", "after-restart");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "run.started",
        run: expect.objectContaining({ nativeId: "after-restart" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent.status",
        status: { state: "working", activity: "starting_turn" },
      }),
    );
    expect(h.history.length).toBeGreaterThan(count);
    const opened = h.question("0").find((event) => event.type === "interaction.opened");
    expect(opened?.interaction.state).toBe("pending");
  });

  it("a background task announcing an unseen child exposes both child and task to clients", () => {
    const h = harness();
    const root = h.see().find((event) => event.type === "agent.created");
    h.start();
    const events = h.send({
      type: "background.started",
      agent: "root",
      task: "child-task",
      kind: "subagent",
      title: "Child research",
      childAgent: "unseen-child",
      item: "spawn",
      stoppable: true,
    });
    const child = events.find((event) => event.type === "agent.created");
    const task = events.find((event) => event.type === "background_task.started");
    expect(child?.agent).toMatchObject({ parentId: root?.agent.id, fidelity: "placeholder" });
    expect(task?.task).toMatchObject({ childAgentId: child?.agent.id, status: "running" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent.updated",
        agentId: child?.agent.id,
        spawnedBy: task?.task.toolCallId,
      }),
    );
  });

  it.each([false, true])(
    "process restart keeps a never-started agent settled after deliberate=%s exit",
    (deliberate) => {
      const h = harness();
      const root = h.see().find((event) => event.type === "agent.created");
      h.send({ type: "process.exited", deliberate });
      const events = h.send({ type: "process.started" });
      expect(events.filter((event) => event.type === "agent.status")).toEqual([]);
      expect(h.agent("root")?.status.state).toBe(deliberate ? "interrupted" : "failed");
      const started = h.start();
      expect(started).toContainEqual({
        type: "agent.status",
        agentId: root?.agent.id,
        status: { state: "working", activity: "starting_turn" },
      });
    },
  );
});
