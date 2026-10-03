import { describe, expect, it } from "vitest";
import { deriveThreadStatus } from "./index.ts";
import { activeRoot, endedRoot } from "./status-test-helper.ts";
import { harness } from "./test-helper.ts";

describe("thread status precedence through facts", () => {
  it("human attention outranks retries, live tools, background tasks, and queued input", () => {
    const h = activeRoot();
    h.shell();
    h.background();
    h.send({ type: "retry", agent: "root", on: "rate_limit" });
    h.send({ type: "queue.changed", count: 1 });
    h.question();
    expect(deriveThreadStatus(h.state)).toEqual({ state: "needs_you", interactions: 1 });
  });

  it.each(["starting", "working", "subagents"] as const)(
    "%s outranks another agent's retry",
    (kind) => {
      const h = kind === "starting" ? endedRoot() : activeRoot();
      h.see("child", "root");
      h.start("child");
      h.send({ type: "retry", agent: "child", on: "upstream" });
      if (kind === "starting") h.see("new-child", "root");
      if (kind === "subagents") {
        h.send({
          type: "item.upsert",
          agent: "root",
          item: "spawn",
          draft: {
            type: "tool_call",
            call: {
              kind: "agent.spawn",
              title: "Child",
              status: "running",
              detail: { kind: "agent.spawn", childAgent: "child" },
            },
          },
        });
      }
      expect(deriveThreadStatus(h.state).state).toBe("working");
    },
  );

  it.each(["rate_limit", "network", "upstream"] as const)(
    "%s retry outranks background and queued work",
    (on) => {
      const h = endedRoot();
      h.send({ type: "retry", agent: "root", on });
      h.background();
      h.send({ type: "queue.changed", count: 1 });
      expect(deriveThreadStatus(h.state)).toEqual(
        on === "rate_limit" ? { state: "limited" } : { state: "waiting", on },
      );
    },
  );

  it("rate-limit retries precede network retries, which precede upstream retries", () => {
    const h = endedRoot();
    h.send({ type: "retry", agent: "root", on: "rate_limit" });
    for (const on of ["network", "upstream"] as const) {
      h.see(on, "root");
      h.start(on);
      h.send({ type: "retry", agent: on, on });
    }
    expect(deriveThreadStatus(h.state)).toEqual({ state: "limited" });
    h.send({ type: "limit.cleared", agent: "root" });
    expect(deriveThreadStatus(h.state)).toEqual({ state: "waiting", on: "network" });
  });

  it("background work outranks a queued input", () => {
    const h = endedRoot();
    h.background();
    h.send({ type: "queue.changed", count: 1 });
    expect(deriveThreadStatus(h.state)).toEqual({ state: "waiting", on: "background_task" });
  });

  it("queued input outranks an unresponsive agent", () => {
    const h = activeRoot();
    h.send({ type: "tick" }, 1000);
    h.send({ type: "queue.changed", count: 1 });
    expect(deriveThreadStatus(h.state)).toEqual({ state: "waiting", on: "queue" });
  });

  it("an unresponsive parent outranks a settled child failure", () => {
    const h = activeRoot();
    h.see("child", "root");
    h.start("child");
    h.end("child", "failed");
    h.send({ type: "tick" }, 1000);
    expect(deriveThreadStatus(h.state)).toEqual({ state: "unresponsive" });
  });

  it("a failed child makes a settled thread failed", () => {
    const h = endedRoot();
    h.see("child", "root");
    h.start("child");
    h.end("child", "failed");
    expect(deriveThreadStatus(h.state)).toEqual({ state: "failed" });
  });

  it("failure precedes new when the process dies before its first turn", () => {
    const h = harness();
    h.see();
    h.send({ type: "process.exited", deliberate: false });
    expect(deriveThreadStatus(h.state)).toEqual({ state: "failed" });
  });

  it("no run yields new; completed and interrupted runs settle the thread", () => {
    expect(deriveThreadStatus(harness().state)).toEqual({ state: "new" });
    for (const outcome of ["completed", "interrupted"] as const) {
      const h = activeRoot();
      h.end("root", outcome);
      expect(deriveThreadStatus(h.state)).toEqual({ state: "done" });
    }
  });

  it("ambient and unknown background tasks permit done", () => {
    const h = endedRoot();
    h.send({
      type: "background.started",
      agent: "root",
      task: "ambient",
      kind: "monitor",
      title: "Watcher",
      ambient: true,
      stoppable: false,
    });
    expect(deriveThreadStatus(h.state)).toEqual({ state: "done" });
    h.background();
    expect(deriveThreadStatus(h.state).state).toBe("waiting");
    h.send({ type: "background.ended", task: "task", status: "unknown" });
    expect(deriveThreadStatus(h.state)).toEqual({ state: "done" });
  });
});

it("activity clears a transient retry while quota recovery requires explicit evidence", () => {
  const h = endedRoot();
  h.send({ type: "retry", agent: "root", on: "rate_limit", until: 5000 });
  h.send({ type: "retry.cleared", agent: "root" });
  expect(deriveThreadStatus(h.state)).toEqual({ state: "limited", until: 5000 });
  h.send({ type: "retry", agent: "root", on: "network" });
  h.send({ type: "retry.cleared", agent: "root" });
  expect(deriveThreadStatus(h.state)).toEqual({ state: "limited", until: 5000 });
  h.send({ type: "limit.cleared", agent: "root" });
  expect(deriveThreadStatus(h.state)).toEqual({ state: "done" });
});
