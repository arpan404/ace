import type { GoalChange, ProviderGoal, Thread } from "@ace/protocol";

/**
 * What a fake provider does with a goal command: the thread's next goal (null clears it), or the
 * error a real daemon would answer.
 */
export function fakeGoalUpdate(
  thread: Thread,
  change: GoalChange | "clear",
  now: number,
): { goal: ProviderGoal | null } | { error: string } {
  if (!thread.capabilities?.goals) return { error: "unsupported_goal" };
  if (change === "clear") return { goal: null };
  if ("objective" in change)
    return { goal: { objective: change.objective, status: "active", tokensUsed: 0, setAt: now } };
  if (!thread.goal) return { error: "goal_not_found" };
  return { goal: { ...thread.goal, status: change.status } };
}
