import { expect, test } from "vitest";
import { ThreadStatus } from "@ace/protocol";
import { agentActivityCounters } from "./decisions.ts";

const idle = { state: "idle" } as const;

test("a subagent whose child thread is in a state this build doesn't know is still live", () => {
  // From a newer daemon: never read as finished.
  const linkedChildStatus = ThreadStatus.parse({ state: "paused" });
  expect(
    agentActivityCounters({
      root: false,
      status: idle,
      linkedChildStatus,
      completionRelevant: true,
    }),
  ).toEqual({ "live:agents": 1, subagentsStarted: 1, subagentsFinished: 0 });
});

test("a subagent whose child thread is done has finished", () => {
  expect(
    agentActivityCounters({
      root: false,
      status: idle,
      linkedChildStatus: { state: "done" },
      completionRelevant: true,
    }),
  ).toEqual({ "live:agents": 0, subagentsStarted: 1, subagentsFinished: 1 });
});
