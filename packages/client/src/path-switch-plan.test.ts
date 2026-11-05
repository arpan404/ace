import { expect, test } from "vitest";
import {
  failoverSteps,
  switchStep,
  type SwitchAction,
  type SwitchEvent,
  type SwitchPhase,
} from "./path-switch-plan.ts";

/** Run events from `opening`, keeping every action in order. */
function run(events: SwitchEvent["type"][]): { phase: SwitchPhase; actions: SwitchAction[] } {
  let phase: SwitchPhase = "opening";
  const actions: SwitchAction[] = [];
  for (const type of events) {
    const step = switchStep(phase, { type });
    phase = step.phase;
    actions.push(...step.actions);
  }
  return { phase, actions };
}

const every: SwitchEvent["type"][] = [
  "welcomed",
  "new_failed",
  "old_failed",
  "drain_elapsed",
  "old_idle",
];
/** Every sequence of up to four events. */
function sequences(length: number): SwitchEvent["type"][][] {
  if (length === 0) return [[]];
  return sequences(length - 1).flatMap((rest) => every.map((event) => rest.concat(event)));
}

test("the old path is never closed before the swap, in any order of events", () => {
  for (const events of sequences(4)) {
    const { actions } = run(events);
    const closed = actions.indexOf("close_old");
    if (closed !== -1) expect(actions.indexOf("swap")).toBeLessThan(closed);
  }
});

test("a failure before the swap closes only the new path and changes nothing else", () => {
  for (const failure of ["new_failed", "old_failed"] as const) {
    expect(run([failure])).toEqual({ phase: "abandoned", actions: ["close_new"] });
    // Nothing that happens afterwards revives the abandoned switch.
    expect(run([failure, "welcomed", "drain_elapsed"]).actions).toEqual(["close_new"]);
  }
});

test.each([
  ["the drain window ends", "drain_elapsed"],
  ["the old path answered everything", "old_idle"],
  ["the old path dies while draining", "old_failed"],
] as const)("after the swap, %s: close the old path and re-ask its commands", (_name, event) => {
  expect(run(["welcomed", event])).toEqual({
    phase: "done",
    actions: ["swap", "start_drain_timer", "close_old", "reask_commands", "fail_old_requests"],
  });
});

test("the new path failing after the swap is not this switch's business", () => {
  expect(run(["welcomed", "new_failed"]).phase).toBe("draining");
});

test("a failover swaps first and re-asks at once", () => {
  expect(failoverSteps()).toEqual(["swap", "close_old", "reask_commands", "fail_old_requests"]);
});
