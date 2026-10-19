import { ProviderGoal, type GoalChange, type ProviderGoalStatus } from "@ace/protocol";
import { obj, str } from "./native.ts";

const statuses: Readonly<Record<string, ProviderGoalStatus>> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage_limited",
  budgetLimited: "budget_limited",
  complete: "complete",
};

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Codex's `ThreadGoal` in ace's shape. Undefined when it has no objective or a status this
 * version doesn't know: the thread keeps showing what it last could, and the frame stays raw.
 */
export function codexGoal(value: unknown): ProviderGoal | undefined {
  const goal = obj(value);
  const status = statuses[str(goal["status"])];
  if (!status) return undefined;
  const tokensUsed = count(goal["tokensUsed"]);
  const tokenBudget = count(goal["tokenBudget"]);
  const timeUsedSeconds = count(goal["timeUsedSeconds"]);
  const createdAt = count(goal["createdAt"]);
  const parsed = ProviderGoal.safeParse({
    objective: str(goal["objective"]).trim(),
    status,
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(timeUsedSeconds === undefined ? {} : { timeUsedSeconds }),
    // Codex stamps goals in Unix seconds.
    ...(createdAt === undefined ? {} : { setAt: createdAt * 1000 }),
  });
  return parsed.success ? parsed.data : undefined;
}

/** `thread/goal/set` and `thread/goal/clear` for one Codex thread, as the person's own edits. */
export function codexGoalCommands(
  request: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
  assertOpen: () => void,
) {
  return {
    async setGoal(change: GoalChange): Promise<void> {
      assertOpen();
      await request("thread/goal/set", {
        threadId,
        origin: "user",
        ...("objective" in change
          ? { objective: change.objective, status: "active" }
          : { status: change.status }),
      });
    },
    async clearGoal(): Promise<void> {
      assertOpen();
      await request("thread/goal/clear", { threadId, origin: "user" });
    },
  };
}
