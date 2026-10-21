import type { OffshiftView } from "@ace/protocol/offshift";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const more = (count: number) => (count > 1 ? ` (${plural(count - 1, "more check")} pending)` : "");

/** The current phase's first step to do, as the sentence that names it. */
function stepToDo(run: OffshiftView["run"]): string | undefined {
  const open = run.steps.filter((step) => step.phase === run.phase && step.state === "todo");
  const [first] = open;
  if (!first) return undefined;
  const rest = open.length > 1 ? ` (${plural(open.length - 1, "more step")} in ${run.phase})` : "";
  return `Step \`${first.id}\`: ${first.title.replace(/[.\s]+$/, "")}. Then call step: done with what you observed, or skipped with the reason${rest}.`;
}

/**
 * The one step an agent takes now, as a short imperative sentence, worked out from the view
 * alone. `children` is how many delegated descendants still work or wait, when known: with
 * none, a working tree is the caller's own turn, which ends by reporting.
 *
 * Order: a blocker; then, from verify on, a failed check; the current phase's next step to do;
 * other pending evidence; advancing; and finally the tree. A step that writes to the run names
 * the version to send, so the agent never has to dig it out of the run or count its calls.
 */
export function nextStep(view: Omit<OffshiftView, "next">, children?: number): string {
  return runStep(view) ?? treeStep(view, children);
}

/** What the run itself asks for next, or undefined when only the tree is left to settle. */
function runStep(view: Omit<OffshiftView, "next">): string | undefined {
  const { run, pending, revision } = view;
  // The caller's own next write; a delegated check is the child's, which reads the run first.
  const write = (sentence: string) => `${sentence} Use version ${run.version}.`;
  if (run.blocker)
    return write(
      `Resolve the blocker: ${run.blocker}. Ask the person if needed, then resume with the decision in note.`,
    );
  const step = stepToDo(run);
  // A run with steps names its work in them, so a phase without steps left just advances.
  const stepped = run.steps.length > 0;
  if (run.phase === "plan")
    return write(
      step ?? (stepped ? "Advance to implement." : "Plan the work, then advance to implement."),
    );
  if (run.phase === "implement")
    return write(
      step ?? (stepped ? "Advance to verify." : "Make the change, then advance to verify."),
    );
  const latest = (item: OffshiftView["pending"][number]) =>
    run.evidence.find(
      (found) => found.criterionId === item.criterionId && found.kind === item.kind,
    );
  // A check that failed at this revision is a known defect: it comes before any step.
  const failing = pending.find((item) => {
    const found = latest(item);
    return found?.result === "fail" && found.revision === revision;
  });
  if (failing)
    return write(
      `Fix \`${failing.criterionId}\`: its ${failing.kind} check failed. Then repeat the check and record the result${more(pending.length)}.`,
    );
  if (step) return write(step);
  // The agent's own checks come first; asking another model to verify follows them.
  const first = pending.find((item) => !item.needs) ?? pending[0];
  if (first) {
    const found = latest(first);
    if (first.needs === "independent")
      return `Ask a different provider or model to verify \`${first.criterionId}\` (${first.kind}): delegate with runRole "verify" and tell the child runOwner "${run.threadId}"${more(pending.length)}.`;
    if (found && found.revision !== revision)
      return write(
        `Repeat the ${first.kind} check for \`${first.criterionId}\`: the source changed since it was recorded${more(pending.length)}.`,
      );
    return write(
      `Record ${first.kind} evidence for \`${first.criterionId}\` at revision ${revision}${more(pending.length)}.`,
    );
  }
  if (run.phase === "review")
    return write(stepped ? "Advance to delivery." : "Review the change, then advance to delivery.");
  if (run.phase === "verify") return write("Advance to review.");
  return undefined;
}

/** What is left once the run needs no more writes: report, or wait on the tree. */
function treeStep(view: Omit<OffshiftView, "next">, children?: number): string {
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
