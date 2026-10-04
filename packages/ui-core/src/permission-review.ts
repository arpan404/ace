import type { ApprovalTarget, Item, PermissionMode, PermissionReview } from "@ace/protocol";

/*
 * ace's permission review (ADR 0061): before an approval reaches a person, ace's risk policy
 * approves it, denies it or sends it on ("escalate"), with a reason and the exact provider input
 * it judged. The daemon records the decision on the interaction and as a notice item whose raw
 * payload carries the review; these turn either into the words the transcript and Activity show.
 */

/**
 * The interaction a `permission-review:*` notice is about, if the item is one. The review
 * itself is read from that interaction (`interaction.review`), which the client parsed when the
 * daemon's `permission.reviewed` event arrived; the notice's raw copy is only its pointer.
 */
export function reviewedInteraction(item: Item | undefined): string | undefined {
  if (item?.type !== "notice") return undefined;
  for (const raw of item.raw) {
    if (raw.type !== "permission.reviewed" || !("data" in raw)) continue;
    const data: unknown = raw.data;
    if (typeof data === "object" && data !== null && "interactionId" in data) {
      const id = data.interactionId;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

export type ReviewTone = "approved" | "denied" | "escalated";

export interface TargetLine {
  label: string;
  value: string;
  /** Show in monospace: commands, paths and directories. */
  code: boolean;
}

export interface ReviewView {
  tone: ReviewTone;
  /** "Approved by ace", "Denied by ace", "Sent to you". */
  verdict: string;
  /** The policy's own reason, verbatim. */
  reason: string;
  /** Who decided: "ace risk policy · Auto-review". */
  reviewer: string;
  /** The tool it judged, as the headline of the target ("Shell", "Write file"). */
  tool: string;
  /** The exact input it judged, line by line. */
  target: TargetLine[];
}

const modeLabels: Record<PermissionMode, string> = {
  "read-only": "Read only",
  ask: "Ask",
  "auto-review": "Auto-review",
  "full-access": "Full access",
};

const reviewerLabels: Record<PermissionReview["reviewer"], string> = {
  "ace-risk-policy": "ace risk policy",
};

const accessLabels: Record<ApprovalTarget["access"], string> = {
  read: "Reads",
  write: "Writes",
  execute: "Runs a command",
  unknown: "Unknown access",
};

/** Paths beyond this many are counted, not listed; the full list stays in the raw review. */
const shownPaths = 6;

function targetLines(target: ApprovalTarget | undefined): TargetLine[] {
  if (!target) return [];
  const lines: TargetLine[] = [];
  if (target.command) lines.push({ label: "Command", value: target.command, code: true });
  if (target.cwd) lines.push({ label: "In", value: target.cwd, code: true });
  const paths = target.paths ?? [];
  paths.slice(0, shownPaths).forEach((path, index) =>
    lines.push({
      label: index === 0 ? (paths.length > 1 ? "Paths" : "Path") : "",
      value: path,
      code: true,
    }),
  );
  if (paths.length > shownPaths)
    lines.push({ label: "", value: `and ${paths.length - shownPaths} more`, code: false });
  lines.push({ label: "Access", value: accessLabels[target.access], code: false });
  return lines;
}

export function describeReview(review: PermissionReview): ReviewView {
  const tone: ReviewTone =
    review.decision === "approve"
      ? "approved"
      : review.decision === "deny"
        ? "denied"
        : "escalated";
  return {
    tone,
    verdict:
      tone === "approved" ? "Approved by ace" : tone === "denied" ? "Denied by ace" : "Sent to you",
    reason: review.reason,
    reviewer: `${reviewerLabels[review.reviewer]} · ${modeLabels[review.mode]}`,
    tool: review.target?.tool ?? "Unknown tool",
    target: targetLines(review.target),
  };
}
