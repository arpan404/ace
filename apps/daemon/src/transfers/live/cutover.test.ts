import { describe, expect, it } from "vitest";
import { cutoverStep, runsHere, type CutoverEvent } from "./cutover.ts";
import { turnStart } from "./turn-start.ts";

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

describe("the moved thread's first turn on the target", () => {
  it.each(["working", "done"] as const)("counts a %s thread as started", (state) => {
    const status = state === "working" ? { state, agents: 1 } : { state };
    expect(turnStart(status)).toEqual({ kind: "running" });
  });

  it("waits while the message is still queued or the thread hasn't begun", () => {
    expect(turnStart({ state: "waiting", on: "queue" })).toEqual({ kind: "wait" });
    expect(turnStart({ state: "new" })).toEqual({ kind: "wait" });
  });

  it("reads the message held unsent by a failure as failed, however long it took", () => {
    expect(turnStart({ state: "failed" })).toEqual({ kind: "failed" });
  });
});
