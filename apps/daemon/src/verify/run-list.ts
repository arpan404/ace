import { verifyListLimit, type VerifyRun } from "@ace/protocol";
import { isSettled } from "./run-state.ts";

/**
 * A project's list, from its runs newest first: every live run, the newest settled check per
 * PR head and the merge runs, newest first and at most `verifyListLimit`.
 */
export function latestRuns(runs: readonly VerifyRun[]): VerifyRun[] {
  const seen = new Set<string>();
  const kept: VerifyRun[] = [];
  for (const run of runs) {
    if (kept.length >= verifyListLimit) break;
    if (run.target.kind === "check" && isSettled(run)) {
      const { pr, headSha } = run.target.pr;
      const key = JSON.stringify([pr.repository.owner, pr.repository.name, pr.number, headSha]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(run);
  }
  return kept;
}
