import type { Automation, AutomationRun, ProviderKind } from "@ace/protocol";

export const providerLabels: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
  acp: "ACP agent",
};

/** "Claude Code · sonnet-4.6, in a fresh worktree". */
export function runsOn(automation: Automation): string {
  const model = automation.model ? ` · ${automation.model}` : "";
  const where = automation.worktree ? "in a fresh worktree" : "in the project checkout";
  return `${providerLabels[automation.provider]}${model}, ${where}`;
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
