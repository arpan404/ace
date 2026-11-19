import { expect, test } from "vitest";
import { workerCoverageGaps } from "../bench/worker-coverage.ts";

const log = (...lines: string[]) => lines.join("\n");

test("every worker announced and watched, nested ones included, leaves no gap", () => {
  expect(
    workerCoverageGaps(
      log("ack 0", "start 1", "ack 1", "start 2", "ack 2", "start 3", "ack 3", "next 4"),
    ),
  ).toEqual([]);
});

test("a worker started past the factory beside a watched one is a gap, live or retired", () => {
  // Worker 1 is watched; worker 2 never announced itself, whether it still runs or not.
  expect(workerCoverageGaps(log("ack 0", "start 1", "ack 1", "next 3"))).toEqual([
    "worker 2 started past ace's worker factory",
  ]);
});

test("an unwatched worker started after every watched one has retired is still a gap", () => {
  expect(
    workerCoverageGaps(log("ack 0", "start 1", "ack 1", "start 2", "ack 2", "next 4")),
  ).toEqual(["worker 3 started past ace's worker factory"]);
});

test("an announced worker that never ran the hook is a gap", () => {
  expect(workerCoverageGaps(log("ack 0", "start 1", "next 2"))).toEqual([
    "worker 1 never ran the hook",
  ]);
});

test("a run whose workers were never counted is not a pass", () => {
  expect(workerCoverageGaps(log("ack 0", "start 1", "ack 1"))).toEqual([
    "the daemon's workers were never counted",
  ]);
});
