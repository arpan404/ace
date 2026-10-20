import type { OffshiftView } from "@ace/protocol/offshift";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The one step an agent takes now, as a short imperative sentence, worked out from the view
 * alone. `children` is how many delegated descendants still work or wait, when known: with
 * none, a working tree is the caller's own turn, which ends by reporting.
 */
export function nextStep(view: Omit<OffshiftView, "next">, children?: number): string {
  const { run, pending, revision } = view;
  if (run.blocker)
    return `Resolve the blocker: ${run.blocker}. Ask the person if needed, then resume with the decision in note.`;
  if (run.phase === "plan") return "Plan the work, then advance to implement.";
  if (run.phase === "implement") return "Make the change, then advance to verify.";
  // The agent's own checks come first; asking another model to verify follows them.
  const first = pending.find((item) => !item.needs) ?? pending[0];
  if (first) {
    const more = pending.length > 1 ? ` (${plural(pending.length - 1, "more check")} pending)` : "";
    const found = run.evidence.find(
      (item) => item.criterionId === first.criterionId && item.kind === first.kind,
    );
    if (first.needs === "independent")
      return `Ask a different provider or model to verify \`${first.criterionId}\` (${first.kind}): delegate with runRole "verify" and tell the child runOwner "${run.threadId}"${more}.`;
    if (found && found.revision !== revision)
      return `Repeat the ${first.kind} check for \`${first.criterionId}\`: the source changed since it was recorded${more}.`;
    if (found?.result === "fail")
      return `Fix \`${first.criterionId}\`: its ${first.kind} check failed. Then repeat the check and record the result${more}.`;
    return `Record ${first.kind} evidence for \`${first.criterionId}\` at revision ${revision}${more}.`;
  }
  if (run.phase === "review") return "Review the change, then advance to delivery.";
  if (run.phase === "verify") return "Advance to review.";
  switch (view.treeState) {
    case "done":
      return "Done. Report the outcome and the checks behind it.";
    case "needs_you":
      return "The tree waits on the person: relay the request, or wait for their answer.";
    case "failed":
      return "A thread in the tree failed: read it with agents_status, repair, and record new evidence.";
    case "working":
      return children
        ? `Wait for the tree: ${plural(children, "child", "children")} still working (call wait).`
        : "Report the outcome and end your turn; the run completes when the tree settles.";
    default:
      return children
        ? `Wait for the tree: ${plural(children, "child", "children")} not settled (call wait).`
        : "Report the outcome and end your turn; the run completes when the tree settles.";
  }
}
