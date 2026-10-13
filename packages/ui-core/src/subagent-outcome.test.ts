import { expect, test } from "vitest";
import { rollupSubagent } from "./subagents.ts";
import { subagentOutcome, subagentPhase } from "./subagent-outcome.ts";

const start = 1_000_000;

test("a finished subagent says how long it took, from the daemon's start and end", () => {
  expect(subagentOutcome(subagentPhase("done"), start, start + 345_000, start + 999_000)).toBe(
    "Completed in 5m 45s",
  );
  expect(subagentOutcome(subagentPhase("failed"), start, start + 12_000, start + 999_000)).toBe(
    "Failed after 12s",
  );
  expect(subagentOutcome(subagentPhase("cancelled"), start, start + 62_000, start + 99_000)).toBe(
    "Stopped after 1m 2s",
  );
});

test("a running subagent counts up to now instead of claiming an end", () => {
  expect(subagentOutcome(subagentPhase("working"), start, undefined, start + 40_000)).toBe(
    "Working for 40s",
  );
  // Still working even when an end time is already known for its own turn.
  expect(subagentOutcome(subagentPhase("waiting"), start, start + 5_000, start + 70_000)).toBe(
    "Working for 1m 10s",
  );
});

test("a done subagent with a working child is still running, and one waiting on the person says so", () => {
  expect(subagentPhase(rollupSubagent("done", "working"))).toBe("running");
  expect(subagentPhase(rollupSubagent("done", "human"))).toBe("human");
  expect(subagentOutcome("human", start, undefined, start + 5_000)).toBe("Waiting on you");
});

test("an ended subagent without a known end names only how it ended", () => {
  expect(subagentOutcome("done", start, undefined, start + 5_000)).toBe("Completed");
});
