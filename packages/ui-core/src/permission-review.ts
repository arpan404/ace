import type { ApprovalTarget, Interaction, PermissionReview } from "@ace/protocol";
import { approvalOutcome, reviewModeNames, reviewReason } from "./approvals.ts";
import { displayCommand, stepPath, type PathContext } from "./step-display.ts";
import { toolDisplayName } from "./tool-labels.ts";
export { reviewedInteraction } from "./review-pointer.ts";

/*
 * ace's permission review (ADR 0061): before an approval reaches a person, ace's risk policy
 * approves it, denies it or sends it on ("escalate"), with a reason and the exact provider input
 * it judged. The daemon records the decision on the interaction and as a notice item whose raw
 * payload carries the review; these turn either into the words the transcript and Activity show.
 */

export type ReviewTone = "approved" | "denied" | "escalated";

export interface TargetLine {
  label: string;
  value: string;
  /** Show in monospace: commands, paths and directories. */
  code: boolean;
}

export interface ReviewView {
  tone: ReviewTone;
  /** "Approved by ace", "Denied by ace", "Sent to you", or the person's answer once given. */
  verdict: string;
  /** The policy's reason, in words. */
  reason: string;
  /** Who decided: "ace risk policy · Auto-review". */
  reviewer: string;
  /** The tool it judged, as people name it ("Command", "File change"); never a raw method. */
  tool: string;
  /** The exact input it judged, line by line. */
  target: TargetLine[];
}

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

function targetLines(target: ApprovalTarget | undefined, context: PathContext): TargetLine[] {
  if (!target) return [];
  const lines: TargetLine[] = [];
  if (target.command)
    lines.push({
      label: "Command",
      value: displayCommand({ command: target.command }).command,
      code: true,
    });
  if (target.cwd)
    lines.push({ label: "In", value: stepPath(target.cwd, context).text, code: true });
  const paths = target.paths ?? [];
  paths.slice(0, shownPaths).forEach((path, index) =>
    lines.push({
      label: index === 0 ? (paths.length > 1 ? "Paths" : "Path") : "",
      value: stepPath(path, context).text,
      code: true,
    }),
  );
  if (paths.length > shownPaths)
    lines.push({ label: "", value: `and ${paths.length - shownPaths} more`, code: false });
  lines.push({ label: "Access", value: accessLabels[target.access], code: false });
  return lines;
}

/**
 * A review in words. With the interaction it reviewed, the verdict follows what happened after
 * (IR-2): an escalated request reads "Approved by you" once the person answered, not "Sent to
 * you".
 */
export function describeReview(
  review: PermissionReview,
  interaction?: Pick<Interaction, "state" | "request" | "resolution" | "review" | "autoReviewed">,
  context: PathContext = {},
): ReviewView {
  const tone: ReviewTone =
    review.decision === "approve"
      ? "approved"
      : review.decision === "deny"
        ? "denied"
        : "escalated";
  const outcome = interaction && tone === "escalated" ? approvalOutcome(interaction) : undefined;
  const settled = outcome && outcome.state !== "pending";
  return {
    tone: settled ? (outcome.tone === "approved" ? "approved" : "denied") : tone,
    verdict: settled
      ? outcome.text
      : tone === "approved"
        ? "Approved by ace"
        : tone === "denied"
          ? "Denied by ace"
          : "Sent to you",
    reason: reviewReason(review),
    reviewer: `${reviewerLabels[review.reviewer]} · ${reviewModeNames[review.mode]}`,
    tool: toolDisplayName(review.target?.tool),
    target: targetLines(review.target, context),
  };
}
