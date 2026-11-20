import { describe, expect, it } from "vitest";
import { cutoverStep, runsHere, type CutoverEvent } from "./cutover.ts";
import { CommandId, RunId } from "@ace/protocol";
import type { InputFate } from "../../engine/input-fate.ts";
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

const facts = (
  state: Exclude<InputFate["state"], "delivered" | "replaced" | "failed">,
  held = false,
) => ({ fate: { state }, held }) as const;
const run = RunId.parse("run-1");

describe("the moved thread's first turn on the target", () => {
  it("counts the continue message as started once a run took it", () => {
    expect(turnStart({ fate: { state: "delivered", runId: run }, held: false })).toEqual({
      kind: "running",
    });
  });

  // ADR 0191, #2332: only a run that took this exact message counts as started.
  it("keeps reading a message the engine can't say reached its run, never counting it started", () => {
    expect(turnStart(facts("uncertain"))).toEqual({ kind: "uncertain" });
  });

  it("waits while the message is out of the queue but no turn has started on it", () => {
    expect(turnStart({ fate: { state: "delivered" }, held: false })).toEqual({ kind: "wait" });
  });

  it("waits while the continue message is queued, on its way, or not yet recorded", () => {
    for (const fate of ["waiting", "sending", "unknown"] as const)
      expect(turnStart(facts(fate))).toEqual({ kind: "wait" });
  });

  it("reads the message held unsent by a failure as failed, however long it took", () => {
    expect(turnStart(facts("waiting", true))).toEqual({ kind: "failed" });
    expect(turnStart({ fate: { state: "failed", error: "Not sent" }, held: false })).toEqual({
      kind: "failed",
    });
  });

  // ADR 0191, #2332: the person's own act ends the start as not started.
  it("leaves the thread to the person once they resent, removed or stopped the message", () => {
    expect(
      turnStart({ fate: { state: "replaced", by: CommandId.parse("again") }, held: false }),
    ).toEqual({ kind: "person", reason: "the person sent the message again" });
    expect(turnStart(facts("removed"))).toEqual({
      kind: "person",
      reason: "the person took the message out",
    });
    expect(turnStart({ ...facts("waiting"), stopped: true })).toEqual({
      kind: "person",
      reason: "the person stopped it",
    });
  });
});
