import { describe, expect, it } from "vitest";
import { harness } from "./test-helper.ts";

describe("recorded provider false-done traps", () => {
  it.each(["claude", "codex", "opencode"] as const)(
    "%s keeps the thread live after the root finishes before its background child",
    (provider) => {
      const h = harness(provider);
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
      expect(h.state.status.state).toBe("working");
      h.end("child");
      expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
      // Claude announces an expected self-start before releasing the final live task.
      h.send({ type: "wake.expected", agent: "root", until: 5_000 });
      h.send({ type: "background.ended", task: "job", status: "completed" });
      expect(h.state.status.state).toBe("working");
      h.send({
        type: "turn.started",
        agent: "root",
        nativeTurnId: "followup",
        trigger: "subagent_result",
      });
      h.end();
      expect(h.state.status).toEqual({ state: "done" });
      const updates = h.history.filter((event) => event.type === "thread.updated");
      expect(updates.filter((event) => event.status?.state === "done")).toHaveLength(1);
    },
  );

  it.each(["claude", "codex"] as const)("%s tracks a shell beyond the ended turn", (provider) => {
    const h = harness(provider);
    h.see();
    h.start();
    h.shell();
    h.background();
    const firstRun = h.state.items.shell?.runId;
    h.end();
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
    h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "still running\n",
    });
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    expect(h.state.items.shell?.runId).toBe(firstRun);
    h.send({ type: "background.ended", task: "task", status: "completed" });
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("Codex interrupt leaves a command live, including its late output and completion", () => {
    const h = harness();
    h.see();
    h.start();
    h.shell();
    h.background();
    h.end("root", "interrupted");
    expect(h.state.agents.root?.agent.status).toMatchObject({
      state: "blocked",
      on: "background_task",
    });
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
    h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "line after interrupt",
    });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    h.send({ type: "background.ended", task: "task", status: "completed" });
    expect(h.state.agents.root?.agent.status).toEqual({ state: "interrupted" });
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("Cursor interrupt cancels an orphaned running call and settles", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.shell();
    const events = h.end("root", "interrupted");
    expect(h.state.items.shell).toMatchObject({
      type: "tool_call",
      call: { status: "cancelled", error: "turn ended without completion" },
    });
    expect(events.find((event) => event.type === "item.updated")).toBeDefined();
    expect(h.state.agents.root?.agent.status).toEqual({ state: "interrupted" });
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("Cursor can retain a terminal unknown task for its invisible interrupted shell", () => {
    const h = harness("cursor");
    h.see();
    h.start();
    h.shell();
    h.background();
    h.send({ type: "background.ended", task: "task", status: "unknown" });
    h.end("root", "interrupted");
    expect(h.state.tasks.task?.status).toBe("unknown");
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("links an OpenCode child announced before its spawning call", () => {
    const h = harness("opencode");
    h.see();
    h.start();
    h.see("child", "root");
    h.start("child");
    h.send({ type: "agent.linked", agent: "child", parent: "root", spawnedBy: "spawn" });
    expect(h.state.agents.child?.agent.spawnedBy).toBeUndefined();
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "spawn",
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          kind: "agent.spawn",
          title: "Count lines",
          status: "running",
          detail: { kind: "agent.spawn", childAgent: "child" },
          raw: [],
        },
      },
    });
    expect(h.state.agents.child?.agent.spawnedBy).toBe(h.state.items.spawn?.id);
    expect(h.state.agents.root?.agent.status).toEqual({
      state: "blocked",
      on: "subagents",
      refs: [h.state.agents.child?.agent.id],
    });
    h.end("child");
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "spawn",
      draft: { type: "tool_call", complete: true, call: { status: "succeeded" } },
    });
    h.end();
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("blocking approval outranks work until resolved", () => {
    const h = harness();
    h.see();
    h.start();
    h.shell();
    h.send({
      type: "interaction.opened",
      agent: "root",
      interaction: "approval",
      item: "shell",
      blocking: true,
      request: {
        kind: "approval",
        title: "Run command?",
        options: [{ id: "once", label: "Allow once", kind: "allow_once" }],
      },
    });
    expect(h.state.status).toEqual({ state: "needs_you", interactions: 1 });
    h.send({
      type: "interaction.closed",
      interaction: "approval",
      state: "resolved",
      resolution: { kind: "approval", optionId: "once" },
    });
    expect(h.state.status.state).toBe("working");
  });

  it("Codex asynchronous question becomes needs_you only when its agent stops working", () => {
    const h = harness();
    h.see();
    h.start();
    h.question("async", "root", false);
    expect(h.state.status.state).toBe("working");
    h.end();
    expect(h.state.interactions.async?.state).toBe("pending");
    expect(h.state.status).toEqual({ state: "needs_you", interactions: 1 });
    h.send({
      type: "interaction.closed",
      interaction: "async",
      state: "resolved",
      resolution: { kind: "question", answers: { q: ["yes"] } },
    });
    expect(h.state.status).toEqual({ state: "done" });
  });

  it("OpenCode overloaded retries retain attempt and backoff across heartbeats", () => {
    const h = harness("opencode");
    h.see();
    h.start();
    h.send({
      type: "retry",
      agent: "root",
      on: "upstream",
      attempt: 1,
      until: 61_000,
      message: "The backend is temporarily overloaded",
    });
    expect(h.state.status).toEqual({ state: "waiting", on: "upstream" });
    h.send({ type: "signal" }, 60_000);
    h.send({ type: "tick" }, 100_000);
    expect(h.state.agents.root?.agent.status).toMatchObject({
      state: "blocked",
      on: "upstream",
      attempt: 1,
      until: 61_000,
    });
    h.send({ type: "retry", agent: "root", on: "upstream", attempt: 2, until: 160_000 });
    h.send({ type: "retry.cleared", agent: "root" });
    expect(h.state.status.state).toBe("working");
  });

  it("process death expires interactions and marks tasks unknown before failing active agents", () => {
    const h = harness();
    h.see();
    h.start();
    h.shell();
    h.background();
    h.question();
    h.see("child", "root");
    h.start("child");
    const events = h.send({
      type: "process.exited",
      deliberate: false,
      message: "Provider crashed",
    });
    expect(h.state.interactions.question?.state).toBe("expired");
    expect(h.state.tasks.task?.status).toBe("unknown");
    for (const entry of Object.values(h.state.agents))
      expect(entry.agent.status).toMatchObject({
        state: "failed",
        error: { kind: "process_exit", message: "Provider crashed" },
      });
    for (const run of Object.values(h.state.runs)) expect(run.state).toBe("failed");
    expect(events.filter((event) => event.type === "run.ended")).toHaveLength(2);
    expect(h.state.status).toEqual({ state: "failed" });
  });

  it("10,000 deltas emit no status churn and remain practical with schema validation", () => {
    const h = harness("opencode");
    h.see();
    h.start("root", "history");
    for (let index = 0; index < 1_000; index++)
      h.send({
        type: "item.upsert",
        agent: "root",
        item: `notice_${index}`,
        draft: { type: "notice", level: "info", text: "Historical event", complete: true },
      });
    h.end();
    for (let index = 0; index < 250; index++) {
      const child = `settled_child_${index}`;
      h.see(child, "root");
      h.start(child);
      h.end(child);
    }
    h.start("root", "stream");
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "reason",
      draft: { type: "reasoning", text: "", complete: false },
    });
    const started = performance.now();
    for (let index = 0; index < 10_000; index++) {
      const events = h.send(
        { type: "item.delta", agent: "root", item: "reason", field: "reasoning", append: "." },
        10_000 + index,
      );
      expect(events.map((event) => event.type)).toEqual(["item.delta"]);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(h.state.items.reason).toMatchObject({ type: "reasoning", text: ".".repeat(10_000) });
  });
});
