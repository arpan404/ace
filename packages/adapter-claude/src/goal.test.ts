import { expect, test } from "vitest";
import { createTranslator } from "./translator.ts";

function claude() {
  const translator = createTranslator({ rootKey: "root" });
  let seq = 0;
  return (value: unknown) =>
    translator
      .translate(
        {
          seq: seq++,
          t: seq,
          dir: "recv",
          channel: "sdk",
          data: { type: "active_goal", value, uuid: `u${seq}`, session_id: "s" },
        },
        seq,
      )
      .filter((fact) => fact.type === "goal.updated");
}

test("Claude's /goal reaches the root agent with its checks and why it isn't met yet", () => {
  const goal = claude();
  expect(
    goal({
      condition: " all tests in packages/api pass ",
      iterations: 2,
      set_at: 1_790_000_000_123,
      tokens_at_start: 40_000,
      last_reason: "two tests still fail",
    }),
  ).toEqual([
    {
      type: "goal.updated",
      agent: "root",
      goal: {
        objective: "all tests in packages/api pass",
        status: "active",
        checks: 2,
        setAt: 1_790_000_000_123,
        lastReason: "two tests still fail",
      },
    },
  ]);
  // Met or cleared: Claude reports no goal at all.
  expect(goal(null)).toEqual([{ type: "goal.updated", agent: "root", goal: null }]);
});

test("a Claude goal with no condition changes nothing the thread shows", () => {
  expect(claude()({ condition: "  ", iterations: 0, set_at: 1, tokens_at_start: 0 })).toEqual([]);
});
