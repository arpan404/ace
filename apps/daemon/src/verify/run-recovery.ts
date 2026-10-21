import type { VerifyRun } from "@ace/protocol";
import { failure, prList, type VerifyEvent } from "./run-state.ts";

/**
 * How a run a restart found unsettled ends. Before GitHub merges it was interrupted; while
 * merging, GitHub's answer (`merged`, the PR numbers it reports merged) decides.
 */
export function settleAfterRestart(
  run: VerifyRun,
  merged: ReadonlySet<number> | undefined,
): VerifyEvent[] {
  if (run.state !== "merging" || run.target.kind !== "merge")
    return [{ type: "settle", state: "interrupted" }];
  if (!merged) return [];
  const events: VerifyEvent[] = [];
  const missing: number[] = [];
  for (const { pr } of run.target.prs) {
    if (!merged.has(pr.number)) {
      missing.push(pr.number);
      continue;
    }
    if (run.merged.includes(pr.number)) continue;
    events.push({ type: "merged", pr: pr.number });
    events.push({ type: "step", kind: "merge", pr: pr.number, state: "done" });
  }
  const first = missing[0];
  events.push(
    first === undefined
      ? { type: "settle", state: "merged" }
      : {
          type: "settle",
          state: "stopped",
          failure: failure(
            "unavailable",
            `ace restarted while merging; ${prList(missing)} ${missing.length === 1 ? "was" : "were"} not merged`,
            { pr: first },
          ),
        },
  );
  return events;
}
