import type { AutomationForm } from "@ace/ui-core/automations";

/** A starting point New automation offers: the prompt, when it runs, and that in a few words. */
export interface Idea {
  prompt: string;
  label: string;
  when: Partial<AutomationForm>;
}

export const ideas: readonly Idea[] = [
  {
    prompt: "Review new pull requests and leave a summary of what changed and what to check.",
    label: "When a pull request opens",
    when: { trigger: "github", event: "pr_changed" },
  },
  {
    prompt: "Find flaky tests from the last day of runs and open a thread for each one.",
    label: "Every night",
    when: { trigger: "schedule", cadence: "daily", time: "02:00" },
  },
  {
    prompt: "Draft release notes from the pull requests merged this week.",
    label: "Fridays",
    when: { trigger: "schedule", cadence: "weekly", day: "FR", time: "16:00" },
  },
];
