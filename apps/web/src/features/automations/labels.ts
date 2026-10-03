import { modelLabel, providerNames } from "@ace/ui-core";
import type { Automation, AutomationRun } from "@ace/protocol";

/** "Claude Code · Sonnet 4.6, in a fresh worktree". */
export function runsOn(automation: Automation): string {
  const model = automation.model ? ` · ${modelLabel(automation.model)}` : "";
  const where = automation.worktree ? "in a fresh worktree" : "in the project checkout";
  return `${providerNames[automation.provider]}${model}, ${where}`;
}

export const missedRunLabels: Record<Automation["missedRun"], string> = {
  run_once: "Run once when ace is back",
  skip: "Skip it",
};

/** What a run found, in one line: "Running…", "Failed: npm registry timeout", the result. */
export function runSummary(run: AutomationRun): string {
  switch (run.status) {
    case "running":
      return "Running…";
    case "failed":
      return `Failed: ${run.result ?? "no result"}`;
    case "skipped":
      return `Skipped${run.result ? `: ${run.result}` : ""}`;
    case "succeeded":
      return run.result ?? "Finished";
  }
}
