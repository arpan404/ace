import { describe, expect, it } from "vitest";
import { harness } from "./test-helper.ts";

describe("fixture ordering and liveness edges", () => {
  it("a Codex child announced idle has never run and must remain starting", () => {
    const h = harness();
    h.see();
    h.start();
    h.see("child", "root", true);
    h.end();
    expect(h.state.agents.child?.agent.status).toEqual({ state: "starting" });
    expect(h.state.status.state).toBe("working");
    h.start("child");
    h.end("child");
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("Codex child completion without a self-started followup can finish the thread", () => {
    const h = harness();
    h.see();
    h.start();
    h.see("child", "root", true);
    h.start("child");
    h.send({
      type: "background.started",
      agent: "root",
      task: "job",
      kind: "subagent",
      title: "Count lines",
      childAgent: "child",
      stoppable: true,
    });
    h.end();
    h.end("child");
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
    h.send({ type: "background.ended", task: "job", status: "completed" });
    expect(h.state.status).toEqual({ state: "done" });
    const events = h.send({ type: "tick" }, 30_000);
    expect(events.filter((event) => event.type === "thread.updated")).toHaveLength(0);
  });

  it("Claude shell notification bridges the 82ms gap before the provider self-starts", () => {
    const h = harness("claude");
    h.see();
    h.start();
    h.shell();
    h.background();
    h.end();
    h.send({ type: "wake.expected", agent: "root", until: 23_499 }, 18_499);
    h.send({ type: "background.ended", task: "task", status: "completed" }, 18_499);
    expect(h.state.status.state).toBe("working");
    h.send({ type: "tick" }, 18_580);
    expect(h.state.status.state).toBe("working");
    h.send(
      { type: "turn.started", agent: "root", nativeTurnId: "notification", trigger: "unknown" },
      18_581,
    );
    const events = h.send(
      {
        type: "turn.ended",
        agent: "root",
        nativeTurnId: "notification",
        outcome: "completed",
        trigger: "background_completion",
      },
      22_426,
    );
    expect(events.find((event) => event.type === "run.ended")).toMatchObject({
      trigger: "background_completion",
    });
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("Claude expected wake releases after its injected grace deadline", () => {
    const h = harness("claude");
    h.see();
    h.start();
    h.end();
    h.send({ type: "wake.expected", agent: "root", until: 5_000 }, 1_000);
    h.send({ type: "tick" }, 4_999);
    expect(h.state.status.state).toBe("working");
    h.send({ type: "tick" }, 5_000);
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("ambient monitors never hold the thread open", () => {
    const h = harness("claude");
    h.see();
    h.start();
    h.send({
      type: "background.started",
      agent: "root",
      task: "watcher",
      kind: "monitor",
      title: "Watch files",
      ambient: true,
      stoppable: true,
    });
    h.end();
    expect(h.state.tasks.watcher?.status).toBe("running");
    expect(h.state.agents.root?.agent.status).toEqual({ state: "idle" });
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("a silent long-running tool is healthy and never times out on silence", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.shell();
    h.send({ type: "tick" }, 600_000);
    expect(h.state.agents.root?.agent.status).toMatchObject({ state: "working", activity: "tool" });
    expect(h.state.status.state).toBe("working");
  });

  it("a live nested descendant prevents its silent ancestors becoming unresponsive", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.see("child", "root");
    h.start("child");
    h.see("grandchild", "child");
    h.start("grandchild");
    h.shell("command", "grandchild");
    h.send({ type: "tick" }, 600_000);
    expect(h.state.agents.root?.agent.status.state).toBe("working");
    expect(h.state.agents.child?.agent.status.state).toBe("working");
    expect(h.state.agents.grandchild?.agent.status).toMatchObject({
      state: "working",
      activity: "tool",
    });
  });

  it("OpenCode reasoning deltas stay healthy through a 165-second busy interval", () => {
    const h = harness("opencode");
    h.see();
    h.start();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "reasoning",
      draft: { type: "reasoning", text: "", complete: false },
    });
    h.send(
      { type: "item.delta", agent: "root", item: "reasoning", field: "text", append: "thinking" },
      60_000,
    );
    h.send(
      { type: "item.delta", agent: "root", item: "reasoning", field: "text", append: " more" },
      120_000,
    );
    h.send({ type: "tick" }, 165_000);
    expect(h.state.status.state).toBe("working");
    expect(h.state.agents.root?.agent.status).toMatchObject({
      state: "working",
      activity: "thinking",
    });
    expect(h.state.items.reasoning).toMatchObject({ type: "reasoning", text: "thinking more" });
  });

  it("OpenCode late trailing user-message snapshots do not restart the settled agent", () => {
    const h = harness("opencode");
    h.see();
    h.start();
    h.end();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "user",
      draft: {
        type: "message",
        role: "user",
        parts: [{ type: "text", text: "Original input" }],
        complete: true,
      },
    });
    expect(h.state.agents.root?.agent.status).toEqual({ state: "idle" });
    expect(h.state.status).toEqual({ state: "done" });
    expect(h.state.items.user?.runId).toBeUndefined();
  });

  it("Cursor can do its own work concurrently with a foreground subagent", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.see("child", "root");
    h.start("child");
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "spawn",
      draft: {
        type: "tool_call",
        call: {
          kind: "agent.spawn",
          title: "Count lines",
          status: "running",
          detail: { kind: "agent.spawn", childAgent: "child" },
          raw: [],
        },
      },
    });
    expect(h.state.agents.root?.agent.status).toMatchObject({ state: "blocked", on: "subagents" });
    h.shell("own-work");
    expect(h.state.agents.root?.agent.status).toMatchObject({
      state: "working",
      activity: "tool",
      itemId: h.state.items["own-work"]?.id,
    });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "own-work",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    expect(h.state.agents.root?.agent.status).toMatchObject({ state: "blocked", on: "subagents" });
  });

  it("Cursor parent pauses after its response while a background child works", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.see("child", "root", true);
    h.start("child");
    h.send({
      type: "background.started",
      agent: "root",
      task: "job",
      kind: "subagent",
      title: "Count lines",
      childAgent: "child",
      stoppable: false,
    });
    h.send({ type: "activity", agent: "root", activity: "responding" });
    expect(h.state.agents.root?.agent.status).toMatchObject({
      state: "blocked",
      on: "background_task",
    });
    h.end("child");
    h.send({ type: "background.ended", task: "job", status: "completed" });
    h.end();
    h.send({
      type: "turn.started",
      agent: "root",
      nativeTurnId: "wake",
      trigger: "subagent_result",
    });
    expect(h.state.status.state).toBe("working");
    h.end();
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("a failed child fails the settled thread even if the root completed", () => {
    const h = harness("opencode");
    h.see();
    h.start();
    h.see("child", "root");
    h.start("child");
    h.end();
    h.send({
      type: "turn.ended",
      agent: "child",
      outcome: "failed",
      error: { kind: "provider", message: "Backend refused" },
    });
    expect(h.state.agents.root?.agent.status).toEqual({ state: "idle" });
    expect(h.state.status).toEqual({ state: "failed" });
  });
});
