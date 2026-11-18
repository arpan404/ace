import { describe, expect, it } from "vitest";
import { cutoverStep, runsHere, type CutoverEvent } from "./cutover.ts";
import { interrupts, safePoint, safePointDeadlineMs } from "./safe-point.ts";
import { turnStart, turnStartMs } from "./turn-start.ts";

const step = (events: CutoverEvent[]) =>
  events.reduce(
    (at, event) => {
      const next = cutoverStep(at.stage, event);
      return { stage: next.stage, effects: [...at.effects, ...next.effects] };
    },
    {
      stage: "readying" as const as ReturnType<typeof cutoverStep>["stage"],
      effects: [] as string[],
    },
  );

describe("a working thread's switch-over, on the machine it leaves", () => {
  it("keeps the agent working until the bulk is there, then stops it and hands over", () => {
    expect(step([{ type: "bulk_held" }, { type: "committing" }, { type: "target_owns" }])).toEqual({
      stage: "moved",
      effects: ["fence", "stop", "record_handing", "move"],
    });
  });

  it("leaves the thread untouched when the bulk can't be sent", () => {
    const failed = step([{ type: "failed", interrupted: false }]);
    expect(failed).toEqual({ stage: "readying", effects: ["fail"] });
    expect(runsHere(failed.stage)).toBe(true);
  });

  it("tells the agent to carry on when the move fails after its turn was stopped", () => {
    expect(step([{ type: "bulk_held" }, { type: "failed", interrupted: true }])).toEqual({
      stage: "resumed",
      effects: ["fence", "stop", "release", "resume", "fail"],
    });
  });

  it("never runs the thread here again on its own once the commit may have landed", () => {
    const lost = step([
      { type: "bulk_held" },
      { type: "committing" },
      { type: "failed", interrupted: true },
      { type: "failed", interrupted: true },
    ]);
    expect(lost.stage).toBe("handing");
    expect(runsHere(lost.stage)).toBe(false);
    expect(lost.effects).not.toContain("resume");
  });

  it("runs here again only on the target's own answer that it never took it", () => {
    expect(
      step([{ type: "bulk_held" }, { type: "committing" }, { type: "target_released" }]).stage,
    ).toBe("resumed");
  });

  it("carries on from where a restart left it, with no second hand-over", () => {
    // A restart repeats the stage's own event: the effect runs again, nothing else changes.
    expect(cutoverStep("stopping", { type: "bulk_held" })).toEqual({
      stage: "stopping",
      effects: ["stop"],
    });
    expect(cutoverStep("handing", { type: "committing" })).toEqual({
      stage: "handing",
      effects: ["record_handing"],
    });
    expect(cutoverStep("moved", { type: "target_owns" }).effects).toEqual([]);
  });

  it("refuses an answer that can't follow the stage", () => {
    expect(() => cutoverStep("readying", { type: "target_owns" })).toThrow();
    expect(() => cutoverStep("moved", { type: "target_released" })).toThrow();
  });
});

describe("the safe point a working turn is stopped at", () => {
  const facts = { turnRunning: true, toolsRunning: 0, streaming: 0 };

  it("needs no interrupt once the turn ended on its own", () => {
    expect(safePoint({ ...facts, turnRunning: false, toolsRunning: 2 }, 0)).toEqual({
      kind: "boundary",
    });
    expect(interrupts(safePoint({ ...facts, turnRunning: false }, 0))).toBe(false);
  });

  it("interrupts between tool calls", () => {
    expect(interrupts(safePoint(facts, 0))).toBe(true);
  });

  it("waits while a tool call runs or a reply streams, then interrupts at the deadline", () => {
    expect(safePoint({ ...facts, toolsRunning: 1 }, 1000)).toEqual({ kind: "wait" });
    expect(safePoint({ ...facts, streaming: 1 }, 1000)).toEqual({ kind: "wait" });
    expect(safePoint({ ...facts, toolsRunning: 1 }, safePointDeadlineMs)).toEqual({
      kind: "deadline",
    });
  });
});

describe("the moved thread's first turn on the target", () => {
  it.each(["working", "done"] as const)("counts a %s thread as started", (state) => {
    const status = state === "working" ? { state, agents: 1 } : { state };
    expect(turnStart(status, { native: true, waitedMs: 0 })).toEqual({ kind: "running" });
  });

  it("tries the summary once when the carried session fails to open", () => {
    expect(turnStart({ state: "failed" }, { native: true, waitedMs: 0 })).toEqual({
      kind: "retry_with_summary",
    });
    expect(turnStart({ state: "failed" }, { native: false, waitedMs: 0 })).toEqual({
      kind: "failed",
    });
  });

  it("doesn't count a message still waiting in the queue as a started turn", () => {
    expect(turnStart({ state: "waiting", on: "queue" }, { native: false, waitedMs: 10 })).toEqual({
      kind: "wait",
    });
  });

  it("waits for a turn that hasn't shown yet, within a bound", () => {
    expect(turnStart({ state: "new" }, { native: false, waitedMs: 10 })).toEqual({ kind: "wait" });
    expect(turnStart({ state: "new" }, { native: false, waitedMs: turnStartMs })).toEqual({
      kind: "failed",
    });
  });
});
