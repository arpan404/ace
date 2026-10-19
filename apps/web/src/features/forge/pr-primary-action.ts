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
  | { kind: "auto-merge-ready"; method: MergeMethod }
  | { kind: "link" }
  | { kind: "blocked"; blockers: string[] }
  | { kind: "merge"; method: MergeMethod }
  | { kind: "none" };

export function prPrimaryAction(input: {
  status: Pick<ForgePrStatus, "state" | "mergeability" | "ci" | "checks">;
  mergeState: ForgeMergeState | undefined;
  method: MergeMethod;
  /** Whether a task is linked: merge writes go through one. */
  linked?: boolean;
  /** Gates that stop a merge, in words ("Checks: 1 failing · 5 ok"). */
  blockers?: readonly string[];
}): PrPrimary {
  const { status, mergeState, method } = input;
  const blockers = input.blockers ?? [];
  if (status.state === "merged" || status.state === "closed")
    return { kind: "state", state: status.state };
  if (status.state === "unknown") return { kind: "none" };
  if (status.mergeability === "conflicting") return { kind: "resolve" };
  if (status.state === "draft") return { kind: "ready" };
  if (mergeState?.autoMerge)
    return { kind: "auto-merge-armed", method: mergeState.autoMerge.method.toLowerCase() };
  if (mergeState?.queue) return { kind: "queued", position: mergeState.queue.position };
  // Merging goes through a linked task; with none, the button offers the link first.
  if (input.linked === false) return { kind: "link" };
  // A failing check or requested changes stop the merge; GitHub can still merge once they clear.
  if (blockers.length)
    return mergeState?.canEnable
      ? { kind: "auto-merge-ready", method }
      : { kind: "blocked", blockers: [...blockers] };
  if (ciLine(status).tone === "pending" && mergeState?.canEnable)
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
    case "auto-merge-ready":
      return "Auto-merge when ready";
    case "link":
      return "Link to merge";
    case "blocked":
      return "Merge blocked";
    case "merge":
      return methodLabels[primary.method];
    case "none":
      return "";
  }
}
