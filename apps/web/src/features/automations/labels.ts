import { choiceLine, modelLabel, providerNames, type ModelChoice } from "@ace/ui-core";
import type { Automation, AutomationRun } from "@ace/protocol";

/**
 * "Claude Code · work · Sonnet 4.5, in a fresh worktree". The model is a catalog row id (model on
 * one account) or a bare model id; the account shows only when the catalog names it.
 */
export function runsOn(automation: Automation, choices: readonly ModelChoice[]): string {
  const where = automation.worktree ? "in a fresh worktree" : "in the project checkout";
  const { model, provider } = automation;
  const choice = model
    ? choices.find((candidate) => candidate.provider === provider && candidate.id === model)
    : undefined;
  if (choice) return `${choiceLine(choice)}, ${where}`;
  const bare = model?.split(":").at(-1);
  const named = bare
    ? choices.find((c) => c.provider === provider && c.modelId === bare)
    : undefined;
  const label = bare ? ` · ${named?.model ?? modelLabel(bare)}` : "";
  return `${providerNames[provider]}${label}, ${where}`;
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

/**
 * A run that wants a look: it failed, or its result says a review asked for changes. The
 * protocol has no verdict field, so a review's words are the signal.
 */
export function runNeedsAttention(run: AutomationRun): boolean {
  if (run.status === "failed") return true;
  return (
    run.status === "succeeded" &&
    /\b(requested changes|changes requested)\b/i.test(run.result ?? "")
  );
}
