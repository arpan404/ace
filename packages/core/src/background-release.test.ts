import { describe, expect, it } from "vitest";
import type { ThreadState } from "./index.ts";
import { harness } from "./test-helper.ts";

/*
 * ADR 0116 (amending ADR 0109): once the thread's main agent finished its turn with a reply,
 * the commands and monitors it left running no longer hold the thread; they stay listed as
 * running. A later turn the provider starts for one is new work.
 */

type Harness = ReturnType<typeof harness>;

function launch(h: Harness, facts: { wakesAgent?: false } = {}) {
  h.see();
  h.start();
  h.shell("dev");
  h.send({
    type: "background.started",
    agent: "root",
    task: "dev",
    kind: "shell",
    title: "bun run dev",
    item: "dev",
    stoppable: true,
    outputPath: "/tmp/tasks/dev.output",
    ...facts,
  });
}

const listening = (h: Harness, ports: number[], target?: ThreadState) =>
  h.send({ type: "background.listening", task: "dev", ports }, undefined, target);

describe("background work left running after the final reply", () => {
  it("a test run the provider will wake the agent for leaves the replied thread done, still listed as running", () => {
    const h = harness("claude");
    launch(h);
    expect(h.view.status).toEqual({ state: "working", agents: 1 });
    h.end();
    expect(h.view.status).toEqual({ state: "done" });
    expect(h.agent("root")?.status).toEqual({ state: "idle" });
    expect(h.task("dev")?.status).toBe("running");
  });

  it("a command the provider never wakes the agent for leaves a finished turn done", () => {
    const h = harness("codex");
    launch(h, { wakesAgent: false });
    h.end();
    expect(h.view.status).toEqual({ state: "done" });
    expect(h.task("dev")?.status).toBe("running");
  });

  it("a dev server's ports are kept for the strip and change nothing about done", () => {
    const h = harness("claude");
    launch(h);
    h.end();
    listening(h, [5173]);
    expect(h.view.status).toEqual({ state: "done" });
    expect(h.task("dev")).toMatchObject({ status: "running", listening: [5173] });
    listening(h, []);
    expect(h.view.status).toEqual({ state: "done" });
    expect(h.task("dev")?.listening).toBeUndefined();
  });

  it("work never releases the agent while its turn still runs", () => {
    const h = harness("claude");
    launch(h, { wakesAgent: false });
    listening(h, [3000]);
    expect(h.view.status).toEqual({ state: "working", agents: 1 });
  });

  it("a stopped turn keeps waiting on a command it left running, whatever the provider reports", () => {
    const h = harness("codex");
    launch(h, { wakesAgent: false });
    h.end("root", "interrupted");
    expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  });

  it("a subagent's command still holds while the main agent works on", () => {
    const h = harness("claude");
    h.see();
    h.start();
    h.see("child", "root", true);
    h.start("child");
    h.send({
      type: "background.started",
      agent: "child",
      task: "watch",
      kind: "shell",
      title: "gh pr checks --watch",
      stoppable: true,
    });
    h.end("child");
    expect(h.agent("child")?.status).toMatchObject({ state: "blocked", on: "background_task" });
    h.end();
    expect(h.view.status).toEqual({ state: "done" });
  });

  it("a background subagent, ace's own bookkeeping and a shell the provider blocks prompts on still hold after the reply", () => {
    for (const facts of [
      { kind: "subagent" as const },
      { kind: "other" as const, internal: true as const },
      { kind: "shell" as const, blocksPrompts: true as const },
    ]) {
      const h = harness("claude");
      h.see();
      h.start();
      h.send({
        type: "background.started",
        agent: "root",
        task: "held",
        title: "Still holds",
        stoppable: false,
        ...facts,
      });
      h.end();
      expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
    }
  });

  it("a command left running never hides other pending work in the tree", () => {
    const h = harness("claude");
    launch(h);
    h.see("child", "root", true);
    h.start("child");
    h.end();
    expect(h.view.status).toEqual({ state: "working", agents: 1 });
    h.question("approval", "child");
    expect(h.view.status).toEqual({ state: "needs_you", interactions: 1 });
    h.send({ type: "interaction.closed", interaction: "approval", state: "resolved" });
    h.end("child");
    expect(h.view.status).toEqual({ state: "done" });
  });

  it("a new turn the provider starts when the command ends makes the thread work again, then done", () => {
    const h = harness("claude");
    launch(h);
    h.end();
    h.send({ type: "background.ended", task: "dev", status: "completed" });
    h.send({
      type: "turn.started",
      agent: "root",
      nativeTurnId: "wake",
      trigger: "background_completion",
    });
    expect(h.view.status).toEqual({ state: "working", agents: 1 });
    h.end();
    expect(h.view.status).toEqual({ state: "done" });
  });

  it("a restored snapshot keeps the release and what still runs", () => {
    const h = harness("claude");
    launch(h);
    h.end();
    const restored = JSON.parse(JSON.stringify(h.state)) as ThreadState;
    h.send({ type: "tick" }, undefined, restored);
    expect(restored.status).toEqual({ state: "done" });
    expect(Object.values(restored.tasks).find((task) => task.title === "bun run dev")?.status).toBe(
      "running",
    );
  });

  it("refuses listening facts with ports out of range", () => {
    const h = harness("claude");
    launch(h);
    h.end();
    listening(h, [70_000]);
    expect(h.task("dev")?.listening).toBeUndefined();
  });
});
