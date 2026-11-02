import { describe, expect, it } from "vitest";
import type { ThreadState } from "./index.ts";
import { harness } from "./test-helper.ts";

/*
 * ADR 0109: background work holds a thread only while its agent may come back for it. A turn
 * that finished with its reply is released from commands the provider won't wake it for, and
 * from services listening on a port; they stay listed as running.
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

describe("background work left running after a finished turn", () => {
  it("a command the provider never wakes the agent for leaves a finished turn done, still listed as running", () => {
    const h = harness("codex");
    launch(h, { wakesAgent: false });
    expect(h.view.status).toEqual({ state: "working", agents: 1 });
    h.end();
    expect(h.view.status).toEqual({ state: "done" });
    expect(h.agent("root")?.status).toEqual({ state: "idle" });
    expect(h.task("dev")?.status).toBe("running");
  });

  it("a background test run the provider will wake the agent for keeps the thread waiting", () => {
    const h = harness("claude");
    launch(h);
    h.end();
    expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
    expect(h.agent("root")?.status).toMatchObject({ state: "blocked", on: "background_task" });
  });

  it("a dev server found listening releases the finished turn, and holds again once it stops listening", () => {
    const h = harness("claude");
    launch(h);
    h.end();
    listening(h, [5173]);
    expect(h.view.status).toEqual({ state: "done" });
    expect(h.task("dev")).toMatchObject({ status: "running", listening: [5173] });
    listening(h, []);
    expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
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

  it("a released dev server never hides other pending work in the tree", () => {
    const h = harness("claude");
    launch(h);
    h.see("child", "root", true);
    h.start("child");
    h.end();
    listening(h, [5173]);
    expect(h.view.status).toEqual({ state: "working", agents: 1 });
    h.question("approval", "child");
    expect(h.view.status).toEqual({ state: "needs_you", interactions: 1 });
    h.send({ type: "interaction.closed", interaction: "approval", state: "resolved" });
    h.end("child");
    expect(h.view.status).toEqual({ state: "done" });
  });

  it("a new turn that the server's exit starts makes the thread work again, then done", () => {
    const h = harness("claude");
    launch(h);
    h.end();
    listening(h, [5173]);
    h.send({ type: "background.ended", task: "dev", status: "failed" });
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
    listening(h, [5173]);
    const restored = JSON.parse(JSON.stringify(h.state)) as ThreadState;
    h.send({ type: "tick" }, undefined, restored);
    expect(restored.status).toEqual({ state: "done" });
    listening(h, [], restored);
    expect(restored.status).toEqual({ state: "waiting", on: "background_task" });
  });

  it("refuses listening facts with ports out of range", () => {
    const h = harness("claude");
    launch(h);
    h.end();
    listening(h, [70_000]);
    expect(h.view.status).toEqual({ state: "waiting", on: "background_task" });
  });
});
