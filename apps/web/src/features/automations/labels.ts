import type { Automation, AutomationRun } from "@ace/protocol";

export const missedRunLabels: Record<Automation["missedRun"], string> = {
  run_once: "Run it once",
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
