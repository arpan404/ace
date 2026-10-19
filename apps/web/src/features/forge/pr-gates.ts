import type { ForgeMergeState, ForgePrStatus } from "@ace/protocol";
import type { ReviewOutcome } from "./pr-summary-model.ts";

/*
 * The merge gates row: what stands between an open PR and merging (checks, reviews, conflicts,
 * the branch), or for a finished one how it ended. Pure; the header renders it, and the primary
 * button reads the same facts, so the two never disagree.
 */

export type GateKey = "checks" | "reviews" | "conflicts" | "branch" | "ended" | "into";
/** Status tones only (`data-tone`); `waiting` is the merged colour, `idle` says nothing yet. */
export type GateTone = "done" | "failed" | "needs-you" | "working" | "waiting" | "idle";
export interface Gate {
  key: GateKey;
  label: string;
  value: string;
  tone: GateTone;
}

export interface GateFacts {
  status: Pick<ForgePrStatus, "state" | "mergeability" | "ci" | "checks">;
  reviewDecision: string | null;
  mergeState: ForgeMergeState | undefined;
  baseBranch: string;
  /** Each reviewer's latest verdict. */
  outcomes: ReadonlyMap<string, ReviewOutcome>;
  /** How it ended, from the PR's activity, when known. */
  ended?: { by?: string | undefined; ago?: string | undefined } | undefined;
  /** Whether the head branch was deleted after it ended, when known. */
  branchDeleted?: boolean | undefined;
}

function checksGate(status: GateFacts["status"]): Gate {
  const label = "Checks";
  const failed = status.checks.filter((c) => c.status === "failure").length;
  const running = status.checks.filter((c) => c.status === "pending").length;
  const ok = status.checks.filter((c) => c.status === "success").length;
  if (failed || status.ci === "failure")
    return {
      key: "checks",
      label,
      value: failed ? `${failed} failing · ${ok} ok` : "Failing",
      tone: "failed",
    };
  if (running || status.ci === "pending")
    return {
      key: "checks",
      label,
      value: running ? `Running ${running}` : "Running",
      tone: "working",
    };
  if (status.ci === "unknown") return { key: "checks", label, value: "Unavailable", tone: "idle" };
  if (ok) return { key: "checks", label, value: `${ok} passed`, tone: "done" };
  return { key: "checks", label, value: "None", tone: "idle" };
}

function reviewsGate(facts: GateFacts): Gate {
  const label = "Reviews";
  const approved = [...facts.outcomes.values()].filter((o) => o === "approved").length;
  const decision = facts.reviewDecision?.toUpperCase() ?? facts.mergeState?.reviewDecision ?? null;
  if (decision === "CHANGES_REQUESTED" || [...facts.outcomes.values()].includes("changes"))
    return { key: "reviews", label, value: "Changes requested", tone: "failed" };
  if (decision === "APPROVED" || (!decision && approved))
    return { key: "reviews", label, value: `${Math.max(1, approved)} approved`, tone: "done" };
  if (decision === "REVIEW_REQUIRED")
    return { key: "reviews", label, value: "Review required", tone: "needs-you" };
  return { key: "reviews", label, value: "None", tone: "idle" };
}

function conflictsGate(status: GateFacts["status"]): Gate {
  const label = "Conflicts";
  if (status.mergeability === "conflicting")
    return { key: "conflicts", label, value: "Conflicting", tone: "failed" };
  if (status.mergeability === "mergeable")
    return { key: "conflicts", label, value: "None", tone: "done" };
  return { key: "conflicts", label, value: "Checking", tone: "working" };
}

function branchGate(mergeState: ForgeMergeState | undefined): Gate {
  const label = "Branch";
  const state = mergeState?.mergeState.toUpperCase();
  if (state === "BEHIND") return { key: "branch", label, value: "Behind", tone: "needs-you" };
  if (!state || state === "UNKNOWN") return { key: "branch", label, value: "—", tone: "idle" };
  return { key: "branch", label, value: "Up to date", tone: "done" };
}

export function prGates(facts: GateFacts): Gate[] {
  const { status } = facts;
  if (status.state === "merged" || status.state === "closed") {
    const merged = status.state === "merged";
    const when = [facts.ended?.by, facts.ended?.ago].filter(Boolean).join(" · ");
    return [
      {
        key: "ended",
        label: merged ? "Merged" : "Closed",
        value: when || (merged ? "Merged" : "Closed"),
        tone: merged ? "waiting" : "failed",
      },
      { key: "into", label: "Into", value: facts.baseBranch, tone: "idle" },
      checksGate(status),
      {
        key: "branch",
        label: "Branch",
        value: facts.branchDeleted === undefined ? "—" : facts.branchDeleted ? "Deleted" : "Kept",
        tone: "idle",
      },
    ];
  }
  return [
    checksGate(status),
    reviewsGate(facts),
    conflictsGate(status),
    branchGate(facts.mergeState),
  ];
}
