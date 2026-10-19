import type { ForgeMergeState, ForgePrStatus } from "@ace/protocol";
import { ciLine, type MergeMethod } from "@ace/ui-core";

/**
 * The one control the PR header shows, chosen from the PR's state. Pure: the header renders it,
 * and the work it starts lives with the writes that own it.
 */
export type PrPrimary =
  | { kind: "state"; state: "merged" | "closed" }
  | { kind: "resolve" }
  | { kind: "ready" }
  | { kind: "auto-merge-armed"; method: string }
  | { kind: "queued"; position: number }
  | { kind: "auto-merge"; method: MergeMethod }
  | { kind: "merge"; method: MergeMethod }
  | { kind: "none" };

export function prPrimaryAction(input: {
  status: Pick<ForgePrStatus, "state" | "mergeability" | "ci" | "checks">;
  mergeState: ForgeMergeState | undefined;
  method: MergeMethod;
}): PrPrimary {
  const { status, mergeState, method } = input;
  if (status.state === "merged" || status.state === "closed")
    return { kind: "state", state: status.state };
  if (status.state === "unknown") return { kind: "none" };
  if (status.mergeability === "conflicting") return { kind: "resolve" };
  if (status.state === "draft") return { kind: "ready" };
  if (mergeState?.autoMerge)
    return { kind: "auto-merge-armed", method: mergeState.autoMerge.method.toLowerCase() };
  if (mergeState?.queue) return { kind: "queued", position: mergeState.queue.position };
  const checks = ciLine(status).tone;
  if (checks !== "success" && checks !== "none" && mergeState?.canEnable)
    return { kind: "auto-merge", method };
  return { kind: "merge", method };
}

const methodLabels: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge",
  rebase: "Rebase and merge",
};

/** The words on the primary control, or on its badge. */
export function prPrimaryLabel(primary: PrPrimary): string {
  switch (primary.kind) {
    case "state":
      return primary.state === "merged" ? "Merged" : "Closed";
    case "resolve":
      return "Resolve conflicts";
    case "ready":
      return "Ready for review";
    case "auto-merge-armed":
      return `Auto-merge (${primary.method})`;
    case "queued":
      return `In merge queue · ${primary.position}`;
    case "auto-merge":
      return `Auto-merge (${primary.method})`;
    case "merge":
      return methodLabels[primary.method];
    case "none":
      return "";
  }
}
