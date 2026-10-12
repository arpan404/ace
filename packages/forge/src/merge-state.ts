import type { ForgeMergeState } from "@ace/protocol/forge-merge-state";
import type { MergeMethod } from "./api.ts";

/** Observe completion against the selected head; never infer it from CI. */
export function mergeStateChangeObserved(
  state: ForgeMergeState,
  headSha: string,
  action: "enable" | "disable" | "dequeue",
  method: MergeMethod,
): boolean {
  if (state.headSha !== headSha) return false;
  return action === "enable"
    ? state.autoMerge?.method === method.toUpperCase() ||
        state.queue !== null ||
        state.state === "MERGED"
    : action === "disable"
      ? state.autoMerge === null
      : state.queue === null;
}
