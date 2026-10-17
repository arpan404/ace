import { OffshiftRun, OffshiftView, type OffshiftRequest } from "@ace/protocol/offshift";

export class OffshiftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffshiftError";
  }
}
export interface Observation {
  revision: string;
  treeState: OffshiftView["treeState"];
}
export interface Context extends Observation {
  threadId: OffshiftRun["threadId"];
  now: number;
}

/** Evidence is a bounded latest observation per criterion/kind, never a transcript history. */
export function view(run: OffshiftRun, observation: Observation): OffshiftView {
  const pending: OffshiftView["pending"] = [];
  for (const criterion of run.criteria) {
    for (const kind of new Set(criterion.requiredKinds)) {
      const evidence = run.evidence.find(
        (item) => item.criterionId === criterion.id && item.kind === kind,
      );
      if (!evidence || evidence.result !== "pass" || evidence.revision !== observation.revision)
        pending.push({ criterionId: criterion.id, kind });
    }
  }
  const state = run.blocker
    ? "blocked"
    : run.phase !== "delivery"
      ? "active"
      : pending.length
        ? "needs_evidence"
        : observation.treeState !== "done"
          ? "waiting_on_tree"
          : "complete";
  return OffshiftView.parse({ run, ...observation, state, pending });
}

/** Pure transition; the caller supplies canonical tree status and a host-owned source revision. */
export function transition(
  current: OffshiftRun | undefined,
  request: OffshiftRequest,
  context: Context,
): OffshiftRun {
  if (request.action === "get" || request.action === "list")
    throw new OffshiftError("Read is not a transition");
  if (request.action === "start") {
    if (current) throw new OffshiftError("Run already exists; use a new runId");
    return OffshiftRun.parse({
      id: request.runId,
      threadId: context.threadId,
      outcome: request.outcome,
      endpoint: request.endpoint,
      criteria: request.criteria,
      phase: "plan",
      version: 0,
      blocker: null,
      note: "Run started",
      evidence: [],
      createdAt: context.now,
      updatedAt: context.now,
    });
  }
  if (!current) throw new OffshiftError("Run not found");
  if (current.version !== request.version)
    throw new OffshiftError("Run changed; get the current version before retrying");
  const next = { ...current, version: current.version + 1, updatedAt: context.now };
  if (request.action === "block") return { ...next, blocker: request.note, note: request.note };
  if (request.action === "resume") return { ...next, blocker: null, note: request.note };
  if (current.blocker) throw new OffshiftError("Resolve the recorded blocker before continuing");
  if (request.action === "evidence") {
    const evidence = request.evidence;
    const criterion = current.criteria.find((item) => item.id === evidence.criterionId);
    if (!criterion || !criterion.requiredKinds.includes(evidence.kind))
      throw new OffshiftError("Evidence does not match a required criterion/kind");
    if (evidence.revision !== context.revision)
      throw new OffshiftError(
        "Source changed since verification; repeat the check at the current revision",
      );
    return OffshiftRun.parse({
      ...next,
      evidence: [
        ...current.evidence.filter(
          (item) => item.criterionId !== evidence.criterionId || item.kind !== evidence.kind,
        ),
        { ...evidence, recordedAt: context.now },
      ],
    });
  }
  const phases = ["plan", "implement", "verify", "review", "delivery"];
  const from = phases.indexOf(current.phase),
    to = phases.indexOf(request.phase);
  // Returning to implementation/verification is necessary after review findings or source edits.
  if (to > from + 1 || to === from)
    throw new OffshiftError("Advance one phase at a time, or return to an earlier phase");
  if (request.phase === "delivery" && view(current, context).pending.length)
    throw new OffshiftError("Delivery requires current passing evidence for every criterion");
  return OffshiftRun.parse({ ...next, phase: request.phase, note: request.note });
}
