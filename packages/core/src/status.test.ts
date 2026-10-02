import { describe, expect, it } from "vitest";
import { deriveThreadStatus } from "./index.ts";
import { activeRoot, createdItemId, endedRoot, spawned, status } from "./status-test-helper.ts";

describe("agent statuses through adapter facts", () => {
  it("process exit fails live work, preserves settled children, and deliberate exit interrupts", () => {
    const h = activeRoot();
    h.see("child", "root");
    h.start("child");
    h.end("child");
    h.question();
    h.send({ type: "retry", agent: "root", on: "network" });
    h.send({ type: "process.exited", deliberate: false, message: "Lost process" }, 200);
    expect(status(h, 200)).toEqual({
      state: "failed",
      error: { kind: "process_exit", message: "Lost process" },
    });
    expect(status(h, 200, "child")).toEqual({ state: "idle" });
    const closed = activeRoot();
    closed.send({ type: "process.exited", deliberate: true }, 200);
    expect(status(closed, 200)).toEqual({ state: "interrupted" });
    expect(deriveThreadStatus(closed.state)).toEqual({ state: "done" });
  });

  it("blocking approval outranks retries and tools, and exposes the retry once resolved", () => {
    const h = activeRoot();
    h.shell();
    h.send({
      type: "retry",
      agent: "root",
      on: "upstream",
      attempt: 3,
      until: 300,
      message: "Overloaded",
    });
    const opened = h.question().find((event) => event.type === "interaction.opened");
    if (opened?.type !== "interaction.opened") throw new Error("Expected interaction");
    expect(status(h, 150)).toEqual({
      state: "blocked",
      on: "human",
      refs: [opened.interaction.id],
    });
    h.send({ type: "interaction.closed", interaction: "question", state: "resolved" });
    expect(status(h, 150)).toEqual({
      state: "blocked",
      on: "upstream",
      refs: [],
      attempt: 3,
      until: 300,
      message: "Overloaded",
    });
  });

  it("foreground children block their parent until it has concurrent tool work or they settle", () => {
    const h = activeRoot();
    const spawnId = createdItemId(spawned(h));
    expect(status(h, 150)).toMatchObject({ state: "blocked", on: "subagents" });
    const ownId = createdItemId(h.shell("own"));
    expect(status(h, 150)).toEqual({ state: "working", activity: "tool", itemId: ownId });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "own",
      draft: { type: "tool_call", call: { status: "succeeded" } },
    });
    h.end("child");
    expect(status(h, 150)).toEqual({ state: "working", activity: "tool", itemId: spawnId });
  });

  it.each(["pending", "running", "awaiting_approval"] as const)(
    "a %s tool survives normal per-agent silence",
    (toolStatus) => {
      const h = activeRoot();
      const id = createdItemId(h.shell());
      h.send({
        type: "item.upsert",
        agent: "root",
        item: "shell",
        draft: { type: "tool_call", call: { status: toolStatus } },
      });
      h.send({ type: "tick" }, 1000);
      expect(status(h, 1000)).toEqual({ state: "working", activity: "tool", itemId: id });
    },
  );

  it("selects the newer parallel tool despite numeric native-key enumeration", () => {
    const h = activeRoot();
    h.shell("20");
    const newer = createdItemId(h.shell("3"));
    expect(status(h, 150)).toEqual({ state: "working", activity: "tool", itemId: newer });
  });

  it("preserves activity details and becomes unresponsive only after the silence threshold", () => {
    const h = activeRoot();
    h.send(
      { type: "activity", agent: "root", activity: "thinking", detail: "Reading context" },
      200,
    );
    h.send({ type: "tick" }, 300);
    expect(status(h, 300)).toEqual({
      state: "working",
      activity: "thinking",
      detail: "Reading context",
    });
    h.send({ type: "tick" }, 301);
    expect(status(h, 301)).toEqual({ state: "unresponsive", lastSignalAt: 200 });
    h.question("async", "root", false);
    h.send({ type: "tick" }, 1000);
    expect(status(h, 1000).state).toBe("working");
  });

  it("live descendants and background commands keep a quiet parent responsive", () => {
    const h = activeRoot();
    h.see("child", "root");
    h.start("child");
    h.shell("child-tool", "child");
    h.send({ type: "tick" }, 1000);
    expect(status(h, 1000).state).toBe("working");
    const task = activeRoot();
    task.send({
      type: "background.started",
      agent: "root",
      task: "job",
      kind: "shell",
      title: "Command",
      stoppable: true,
    });
    task.send({ type: "tick" }, 1000);
    expect(status(task, 1000).state).toBe("working");
  });

  it("a settled descendant's recent signal resets its parent silence threshold", () => {
    const h = activeRoot();
    h.see("child", "root");
    h.start("child");
    h.end("child");
    h.send({ type: "signal", agent: "child" }, 990);
    h.send({ type: "tick" }, 1000);
    expect(status(h, 1000).state).toBe("working");
    h.send({ type: "tick" }, 1091);
    expect(status(h, 1091)).toEqual({ state: "unresponsive", lastSignalAt: 990 });
  });

  it("tracking a Codex child as a task preserves its foreground behavior", () => {
    const h = activeRoot();
    spawned(h);
    h.send({
      type: "background.started",
      agent: "root",
      task: "job",
      kind: "subagent",
      title: "Child",
      childAgent: "child",
      item: "spawn",
      stoppable: true,
    });
    expect(status(h, 150)).toMatchObject({ state: "blocked", on: "subagents" });
  });

  it("expected self-started work covers the gap and expires at the injected deadline", () => {
    const h = endedRoot();
    h.send({ type: "wake.expected", agent: "root", until: 200 });
    h.send({ type: "tick" }, 199);
    expect(status(h, 199)).toEqual({ state: "working", activity: "starting_turn" });
    h.send({ type: "tick" }, 200);
    expect(status(h, 200)).toEqual({ state: "idle" });
  });

  it("a child without its first turn keeps a completed parent waiting", () => {
    const h = endedRoot();
    h.see("child", "root");
    expect(status(h, 150)).toMatchObject({ state: "blocked", on: "background_task" });
    expect(status(h, 150, "child")).toEqual({ state: "starting" });
    expect(deriveThreadStatus(h.state).state).toBe("working");
  });

  it.each(["interrupted", "failed"] as const)(
    "live tasks outrank %s, until the task becomes unknown",
    (outcome) => {
      const h = activeRoot();
      h.shell();
      h.background();
      h.send({
        type: "turn.ended",
        agent: "root",
        outcome,
        error: { kind: "auth", message: "Sign in" },
      });
      expect(status(h, 150)).toMatchObject({ state: "blocked", on: "background_task" });
      h.send({ type: "background.ended", task: "task", status: "unknown" });
      expect(status(h, 150)).toEqual(
        outcome === "failed"
          ? { state: "failed", error: { kind: "auth", message: "Sign in" } }
          : { state: "interrupted" },
      );
    },
  );

  it("derivation leaves snapshots unchanged and repeated facts emit no redundant statuses", () => {
    const h = activeRoot();
    const before = JSON.stringify(h.state);
    expect(status(h, 150)).toEqual({ state: "working", activity: "starting_turn" });
    expect(JSON.stringify(h.state)).toBe(before);
    const events = h.send({ type: "activity", agent: "root", activity: "starting_turn" });
    expect(
      events.filter((event) => event.type === "agent.status" || event.type === "thread.updated"),
    ).toEqual([]);
    h.send({ type: "activity", agent: "root", activity: "thinking" }, 200);
    const changed = JSON.stringify(h.state);
    expect(status(h, 200)).toEqual({ state: "working", activity: "thinking" });
    expect(status(h, 301)).toEqual({ state: "unresponsive", lastSignalAt: 200 });
    expect(JSON.stringify(h.state)).toBe(changed);
  });

  it("changing returned status payloads cannot change future derived state", () => {
    const h = activeRoot();
    const events = h.question();
    const original = status(h, 150);
    for (const event of events) {
      if (event.type === "agent.status" && event.status.state === "blocked")
        event.status.refs.length = 0;
      if (event.type === "thread.updated" && event.status?.state === "needs_you")
        event.status.interactions = 99;
    }
    expect(status(h, 150)).toEqual(original);
    expect(deriveThreadStatus(h.state)).toEqual({ state: "needs_you", interactions: 1 });
    expect(
      h
        .send({ type: "tick" }, 150)
        .filter((event) => event.type === "agent.status" || event.type === "thread.updated"),
    ).toEqual([]);
  });
});
