import type { ForgeStackLayer, ForgeStackOperation } from "@ace/protocol";

/** What a stack operation's state means to the person, worded for its action. */
export function stackOperationLabel(operation: ForgeStackOperation): string {
  const { action, state } = operation;
  const noun =
    action === "merge"
      ? "Merge"
      : action === "push"
        ? "Publish"
        : action === "abort"
          ? "Abort"
          : action === "sync"
            ? "Sync"
            : "Rebase";
  switch (state) {
    case "pending":
      return `${noun} in progress`;
    case "merged":
      return "Merged";
    case "enqueued":
      return "Queued to merge";
    case "failed":
      return `${noun} failed`;
    case "uncertain":
      return `${noun} outcome unknown`;
    case "conflict":
      return `${action === "sync" ? "Sync" : "Rebase"} conflict`;
    case "push_partial":
      return action === "sync" ? "GitHub commits brought in, not pushed" : "Rebased, not pushed";
    case "rebased":
      return action === "push" ? "Published" : "Rebased";
    case "aborted":
      return "Rebase aborted";
  }
}

/** GitHub's pull request state for a layer. */
export function layerStateLabel(state: string): string {
  return (
    { OPEN: "Open", MERGED: "Merged", CLOSED: "Closed", DRAFT: "Draft" }[state] ?? humanize(state)
  );
}

/** GitHub's merge state status, as a blocker the person can act on. */
export function mergeRulesLabel(mergeState: string): string {
  return (
    {
      CLEAN: "Ready to merge",
      HAS_HOOKS: "Ready to merge",
      BLOCKED: "Blocked by merge rules",
      BEHIND: "Behind its base",
      DIRTY: "Has conflicts",
      UNSTABLE: "Failing non-required checks",
      DRAFT: "Draft",
      UNKNOWN: "Merge rules unknown",
    }[mergeState] ?? humanize(mergeState)
  );
}

export type Signal = "good" | "pending" | "bad" | "unknown";

/** Check and status-context states that block a merge. */
const failing = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/** Required checks GitHub reported in a failing state; any of them blocks the layer's merge. */
export function failingRequiredChecks(layer: Pick<ForgeStackLayer, "requiredChecks">): string[] {
  return layer.requiredChecks
    .filter((check) => failing.has(check.state))
    .map((check) => check.name);
}

/** What stands between the layer and a merge; failing required checks block it outright. */
export function layerMergeBlocker(layer: Pick<ForgeStackLayer, "mergeState" | "requiredChecks">): {
  blocked: boolean;
  label: string;
} {
  if (failingRequiredChecks(layer).length)
    return { blocked: true, label: "Blocked by failing required checks" };
  return {
    blocked: !["CLEAN", "HAS_HOOKS", "UNKNOWN"].includes(layer.mergeState),
    label: mergeRulesLabel(layer.mergeState),
  };
}

/** The layer's checks signal: a failing required check outranks GitHub's rollup state. */
export function layerChecksSignal(layer: Pick<ForgeStackLayer, "checksState" | "requiredChecks">): {
  signal: Signal;
  label: string;
} {
  const failed = failingRequiredChecks(layer);
  if (failed.length)
    return {
      signal: "bad",
      label:
        failed.length === 1 ? `${failed[0]} failing` : `${failed.length} required checks failing`,
    };
  return checksSignal(layer.checksState);
}

export function checksSignal(state: ForgeStackLayer["checksState"]): {
  signal: Signal;
  label: string;
} {
  if (state === "SUCCESS") return { signal: "good", label: "Checks passing" };
  if (state === "PENDING" || state === "EXPECTED")
    return { signal: "pending", label: "Checks running" };
  if (state && failing.has(state)) return { signal: "bad", label: "Checks failing" };
  return { signal: "unknown", label: state ? `Checks ${humanize(state)}` : "Checks unknown" };
}

export function reviewSignal(decision: ForgeStackLayer["reviewDecision"]): {
  signal: Signal;
  label: string;
} {
  if (decision === "APPROVED") return { signal: "good", label: "Approved" };
  if (decision === "REVIEW_REQUIRED") return { signal: "pending", label: "Review required" };
  if (decision === "CHANGES_REQUESTED") return { signal: "bad", label: "Changes requested" };
  return { signal: "unknown", label: decision ? humanize(decision) : "Review unknown" };
}

/** One required check's state: `SUCCESS` reads "passing", `PENDING` "running". */
export function checkStateLabel(state: string): string {
  return checksSignal(state)
    .label.replace(/^Checks /, "")
    .toLowerCase();
}

/** `SOME_STATE` → "Some state", for values GitHub adds later. */
function humanize(value: string): string {
  const words = value.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
