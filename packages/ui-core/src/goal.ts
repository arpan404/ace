import type { GoalChange, ProviderGoal, ProviderGoalStatus } from "@ace/protocol";
import { formatElapsed } from "./time.ts";
import { formatTokens } from "./usage-cost.ts";

const titles: Readonly<Record<ProviderGoalStatus, string>> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usage_limited: "Goal paused at a usage limit",
  budget_limited: "Goal reached its token budget",
  complete: "Goal complete",
};

/** What the strip calls a goal in this state: "Pursuing goal", "Goal paused", … */
export function goalTitle(status: ProviderGoalStatus): string {
  return titles[status];
}

/** "120K / 500K tokens · 14m 2s · 3 checks", leaving out what the provider didn't report. */
export function goalUsage(goal: ProviderGoal): string | undefined {
  const parts: string[] = [];
  if (goal.tokensUsed)
    parts.push(
      goal.tokenBudget
        ? `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)} tokens`
        : `${formatTokens(goal.tokensUsed)} tokens`,
    );
  if (goal.timeUsedSeconds && goal.timeUsedSeconds >= 60)
    parts.push(formatElapsed(goal.timeUsedSeconds * 1000));
  if (goal.checks) parts.push(`${goal.checks} ${goal.checks === 1 ? "check" : "checks"}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** A goal stays settable again (resumed) unless it is already being pursued or is done. */
export function goalResumable(status: ProviderGoalStatus): boolean {
  return status !== "active" && status !== "complete";
}

const words: Readonly<Record<string, "clear" | GoalChange>> = {
  clear: "clear",
  pause: { status: "paused" },
  resume: { status: "active" },
};

/**
 * A `/goal` command typed in the composer, for providers whose goals ace sets natively:
 * `/goal <objective>` sets one, `/goal pause|resume|clear` changes it. Undefined for anything else,
 * which is sent as the message it is (bare `/goal` included).
 */
export function parseGoalCommand(text: string): "clear" | GoalChange | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  const rest = match?.[1]?.trim();
  if (!rest) return undefined;
  return words[rest.toLowerCase()] ?? { objective: rest };
}
