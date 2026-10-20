import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { codexGoalCommands } from "./goal.ts";
import { createCodexTranslator } from "./translator.ts";

function codex() {
  const translator = createCodexTranslator({ threadId: ThreadId.parse("t"), rootKey: "root" });
  let seq = 0;
  const recv = (method: string, params: unknown) =>
    translator
      .translate(
        { seq: seq++, t: seq, dir: "recv", channel: "stdio", data: { method, params } },
        seq,
      )
      .filter((fact) => fact.type === "goal.updated");
  recv("thread/started", { thread: { id: "native", cwd: "/repo" } });
  return recv;
}
const goal = (status: string) => ({
  threadId: "native",
  objective: "  all tests in packages/api pass ",
  status,
  tokenBudget: 500_000,
  tokensUsed: 120_000,
  timeUsedSeconds: 842,
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_900,
});

test("Codex's goal reaches the root agent in ace's words, and clearing it says so", () => {
  const recv = codex();
  expect(
    recv("thread/goal/updated", { threadId: "native", turnId: null, goal: goal("budgetLimited") }),
  ).toEqual([
    {
      type: "goal.updated",
      agent: "root",
      goal: {
        objective: "all tests in packages/api pass",
        status: "budget_limited",
        tokenBudget: 500_000,
        tokensUsed: 120_000,
        timeUsedSeconds: 842,
        setAt: 1_790_000_000_000,
      },
    },
  ]);
  expect(recv("thread/goal/cleared", { threadId: "native" })).toEqual([
    { type: "goal.updated", agent: "root", goal: null },
  ]);
});

test("a goal status this version doesn't know changes nothing the thread shows", () => {
  const recv = codex();
  expect(
    recv("thread/goal/updated", { threadId: "native", turnId: null, goal: goal("dreaming") }),
  ).toEqual([]);
});

test("setting, pausing and clearing a goal from ace are the person's own edits to Codex", async () => {
  const sent: [string, unknown][] = [];
  const commands = codexGoalCommands(
    async (method, params) => {
      sent.push([method, params]);
      return {};
    },
    "native",
    () => {},
  );
  await commands.setGoal({ objective: "ship the release" });
  await commands.setGoal({ status: "paused" });
  await commands.clearGoal();
  expect(sent).toEqual([
    [
      "thread/goal/set",
      { threadId: "native", origin: "user", objective: "ship the release", status: "active" },
    ],
    ["thread/goal/set", { threadId: "native", origin: "user", status: "paused" }],
    ["thread/goal/clear", { threadId: "native", origin: "user" }],
  ]);
});
