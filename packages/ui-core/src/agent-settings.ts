import { homeSortOptions } from "./arrange.ts";
import { effortLabel } from "./models.ts";

/*
 * Settings › Agents in words every client shares: the rows' titles and the choices they offer.
 * The web's Settings page and the phone's per-machine Agents page read the same lists, so a
 * choice can't be named one way on one and another way on the other.
 */

/** Row titles for the daemon settings on the Agents page, by settings-index id. */
export const agentSettingTitles = {
  "providers.default": "Default provider for new threads",
  "access.defaultMode": "Access",
  "threads.useWorktree": "New threads use a worktree",
  "threads.forkOnSwitch": "Fork when switching providers",
  "threads.followUpBehavior": "Messages sent while the agent works",
  "threads.limitPolicy": "When an account hits its limit",
  "agents.maxRunningChildren": "Agents a thread runs at once",
  "threads.sortBy": "Sort threads",
  "threads.autoSettleAfter": "Settle done threads",
  "threads.settleOnMerge": "Settle when the PR merges",
  "threads.settleOnClose": "Settle when the PR closes",
  "generation.model": "Titles and commit messages",
  "generation.autoDraftCommits": "Auto-draft commit messages",
  "automations.enabled": "Run automations",
  "roles.build": "Build",
  "roles.judgment": "Judgment",
  "roles.review": "Review",
  "roles.verify": "Verify",
} as const;

export interface SettingChoice<T> {
  value: T;
  label: string;
}

export const followUpChoices: readonly SettingChoice<"queue" | "steer">[] = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
];

export type LimitPolicyChoice = "manual" | "resume_at_reset" | "snooze_until_reset" | "migrate_now";
export const limitPolicyChoices: readonly SettingChoice<LimitPolicyChoice>[] = [
  { value: "manual", label: "Stop and ask me" },
  { value: "resume_at_reset", label: "Resume when it resets" },
  { value: "snooze_until_reset", label: "Snooze until it resets" },
  { value: "migrate_now", label: "Move to another account" },
];

export const autoSettleChoices: readonly SettingChoice<"1d" | "2d" | "1w" | "never">[] = [
  { value: "1d", label: "After a day" },
  { value: "2d", label: "After 2 days" },
  { value: "1w", label: "After a week" },
  { value: "never", label: "Never" },
];

export const sortByChoices: readonly SettingChoice<"activity" | "created" | "manual">[] =
  homeSortOptions.map((option) => ({ value: option.id, label: option.label }));

/** The counts offered for `agents.maxRunningChildren`, beside No limit. */
export const childLimitPresets: readonly number[] = [1, 2, 4, 8, 16, 32];

/**
 * The child-limit choices: No limit, then the presets, with a count saved elsewhere (a settings
 * file) kept in its place so the page never lies.
 */
export function childLimitChoices(current: number | null): SettingChoice<number | null>[] {
  const counts = new Set(current === null ? childLimitPresets : [...childLimitPresets, current]);
  return [
    { value: null, label: "No limit" },
    ...[...counts]
      .toSorted((a, b) => a - b)
      .map((count) => ({ value: count, label: String(count) })),
  ];
}

/** What the child limit means for the person, under its row. */
export function childLimitNote(current: number | null): string {
  return current === null
    ? "Agents a thread hands work to all start at once."
    : "More agents a thread hands work to wait and start as these finish.";
}

/** Role efforts, `default` leaving it to the provider. */
export const roleEfforts = ["default", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type RoleEffort = (typeof roleEfforts)[number];
export const roleEffortChoices: readonly SettingChoice<RoleEffort>[] = roleEfforts.map((value) => ({
  value,
  label: value === "default" ? "Default effort" : effortLabel(value),
}));
