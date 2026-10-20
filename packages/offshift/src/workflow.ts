import {
  OffshiftRun,
  OffshiftView,
  type OffshiftAuthor,
  type OffshiftCriterion,
  type OffshiftEvidence,
  type OffshiftRequest,
} from "@ace/protocol/offshift";
import { nextStep } from "./next.ts";

export class OffshiftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffshiftError";
  }
}
export interface Observation {
  revision: string;
  treeState: OffshiftView["treeState"];
  /** Delegated descendants still working or waiting on the person, when the host knows. */
  children?: number;
}
export interface Context extends Observation {
  /** The thread that owns the run. */
  threadId: OffshiftRun["threadId"];
  /** The authenticated thread making the call: the owner, or a descendant recording evidence. */
  caller: OffshiftAuthor;
  now: number;
}

/**
 * Whether `by` checked independently of the run owner: another thread on another provider, or
 * on the same provider with a model known to differ. An unknown model never counts as different.
 */
export function independentOf(owner: OffshiftAuthor, by: OffshiftAuthor): boolean {
  if (by.threadId === owner.threadId) return false;
  if (by.provider !== owner.provider) return true;
  return by.model !== null && owner.model !== null && by.model !== owner.model;
}

/** Where one required kind stands at `revision`. */
export function evidenceState(
  run: OffshiftRun,
  criterion: OffshiftCriterion,
  found: OffshiftEvidence | undefined,
  revision: string,
): "pass" | "fail" | "stale" | "missing" | "not_independent" {
  if (!found) return "missing";
  if (found.revision !== revision) return "stale";
  if (found.result === "fail") return "fail";
  return criterion.independent && !independentOf(run.owner, found.by) ? "not_independent" : "pass";
}

/** Evidence is a bounded latest observation per criterion/kind, never a transcript history. */
export function view(run: OffshiftRun, observation: Observation): OffshiftView {
  const pending: OffshiftView["pending"] = [];
  for (const criterion of run.criteria) {
    for (const kind of new Set(criterion.requiredKinds)) {
      const found = run.evidence.find(
        (item) => item.criterionId === criterion.id && item.kind === kind,
      );
      const state = evidenceState(run, criterion, found, observation.revision);
      if (state === "not_independent")
        pending.push({ criterionId: criterion.id, kind, needs: "independent" });
      else if (state !== "pass") pending.push({ criterionId: criterion.id, kind });
    }
  }
  const state: OffshiftView["state"] = run.blocker
    ? "blocked"
    : run.phase !== "delivery"
      ? "active"
      : pending.length
        ? "needs_evidence"
        : observation.treeState !== "done"
          ? "waiting_on_tree"
          : "complete";
  const { revision, treeState } = observation;
  const shape = { run, revision, treeState, state, pending };
  return OffshiftView.parse({ ...shape, next: nextStep(shape, observation.children) });
}

const phases = ["plan", "implement", "verify", "review", "delivery"] as const;

/** Pure transition; the caller supplies canonical tree status and a host-owned source revision. */
export function transition(
  current: OffshiftRun | undefined,
  request: OffshiftRequest,
  context: Context,
): OffshiftRun {
  if (request.action === "get" || request.action === "list")
    throw new OffshiftError("Read is not a transition");
  // A descendant reaches an ancestor's run only to record evidence.
  if (context.caller.threadId !== context.threadId && request.action !== "evidence")
    throw new OffshiftError(
      "With runOwner you may only get the run or record evidence; the owner makes every other change",
    );
  if (request.action === "start") {
    if (current)
      throw new OffshiftError(
        `Run ${request.runId} already exists; call get with runId "${request.runId}" to resume it, or start with a new runId`,
      );
    return OffshiftRun.parse({
      id: request.runId,
      threadId: context.threadId,
      outcome: request.outcome,
      endpoint: request.endpoint,
      criteria: request.criteria,
      owner: context.caller,
      roles: request.roles ?? {},
      phase: "plan",
      version: 0,
      blocker: null,
      note: "Run started",
      evidence: [],
      createdAt: context.now,
      updatedAt: context.now,
    });
  }
  if (!current)
    throw new OffshiftError(`Run ${request.runId} not found; call list to see this thread's runs`);
  if (current.version !== request.version)
    throw new OffshiftError(
      `Run changed: it is at version ${current.version}; call get with runId "${current.id}", reconcile, then retry with version ${current.version}`,
    );
  const next = { ...current, version: current.version + 1, updatedAt: context.now };
  if (request.action === "block") return { ...next, blocker: request.note, note: request.note };
  if (request.action === "resume") return { ...next, blocker: null, note: request.note };
  if (request.action === "roles")
    return OffshiftRun.parse({ ...next, roles: request.roles, note: "Roles changed" });
  if (current.blocker)
    throw new OffshiftError(
      `Resolve the recorded blocker first: call resume with runId "${current.id}", version ${current.version} and the decision in note`,
    );
  if (request.action === "revise") return revise(current, next, request.criterion, request.note);
  if (request.action === "evidence") {
    const evidence = request.evidence;
    const criterion = current.criteria.find((item) => item.id === evidence.criterionId);
    if (!criterion || !criterion.requiredKinds.includes(evidence.kind))
      throw new OffshiftError(
        `Evidence does not match a required criterion/kind; call get with runId "${current.id}" and use a criterion id with one of its requiredKinds`,
      );
    if (evidence.revision !== context.revision)
      throw new OffshiftError(
        `Source changed since verification; call get with runId "${current.id}", repeat the check, then record evidence with the revision get returns`,
      );
    return OffshiftRun.parse({
      ...next,
      evidence: [
        ...current.evidence.filter(
          (item) => item.criterionId !== evidence.criterionId || item.kind !== evidence.kind,
        ),
        { ...evidence, recordedAt: context.now, by: context.caller },
      ],
    });
  }
  const from = phases.indexOf(current.phase),
    to = phases.indexOf(request.phase);
  // Returning to implementation/verification is necessary after review findings or source edits.
  if (to > from + 1 || to === from)
    throw new OffshiftError(
      from + 1 < phases.length
        ? `Advance one phase at a time: the next is ${phases[from + 1]}; or return to an earlier phase`
        : "The run is in delivery; return to an earlier phase to repair",
    );
  if (request.phase === "delivery") {
    const pending = view(current, context).pending;
    const first = pending[0];
    if (first)
      throw new OffshiftError(
        `Delivery requires a counting pass for every criterion: ${pending.length} pending, first ${first.kind} for ${first.criterionId}${first.needs ? " from another provider or model" : ""}; call get and follow next`,
      );
  }
  return OffshiftRun.parse({ ...next, phase: request.phase, note: request.note });
}

/**
 * A revised criterion is a new requirement: earlier passes checked the old wording, so its
 * evidence is dropped and must be gathered again.
 */
function revise(
  current: OffshiftRun,
  next: OffshiftRun,
  criterion: OffshiftCriterion,
  note: string,
): OffshiftRun {
  const replaces = current.criteria.some((item) => item.id === criterion.id);
  if (!replaces && current.criteria.length >= 64)
    throw new OffshiftError("A run holds at most 64 criteria; replace one or start a new run");
  return OffshiftRun.parse({
    ...next,
    criteria: replaces
      ? current.criteria.map((item) => (item.id === criterion.id ? criterion : item))
      : [...current.criteria, criterion],
    evidence: current.evidence.filter((item) => item.criterionId !== criterion.id),
    note,
  });
}
