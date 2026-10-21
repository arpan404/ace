import {
  OffshiftRun,
  OffshiftView,
  type OffshiftAuthor,
  type OffshiftCriterion,
  type OffshiftEvidence,
  type OffshiftEvidenceInput,
  type OffshiftRequest,
  type OffshiftStep,
} from "@ace/protocol/offshift";
import { nextStep } from "./next.ts";
import { playbook } from "./playbooks.ts";

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
 * on the same provider with a model known to differ. An unknown model or author never counts.
 */
export function independentOf(owner: OffshiftAuthor | null, by: OffshiftAuthor | null): boolean {
  if (!owner || !by) return false;
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
  // Delivery steps still to do (the report itself) keep the run active.
  const state: OffshiftView["state"] = run.blocker
    ? "blocked"
    : run.phase !== "delivery" || todo(run, "delivery").length
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

/** The steps of `phase` still to do, in order. */
export function todo(run: OffshiftRun, phase: OffshiftRun["phase"]): OffshiftStep[] {
  return run.steps.filter((step) => step.phase === phase && step.state === "todo");
}

/** A playbook's steps, then the custom ones, in phase order (stable within a phase). */
function startSteps(request: Extract<OffshiftRequest, { action: "start" }>): OffshiftStep[] {
  const listed = [
    ...(request.playbook ? playbook(request.playbook).steps : []),
    ...(request.steps ?? []),
  ];
  const ids = new Set<string>();
  for (const step of listed) {
    if (ids.has(step.id))
      throw new OffshiftError(
        `Step id ${step.id} is used twice${request.playbook ? ` (the ${request.playbook} playbook already has it)` : ""}; give your step another id`,
      );
    ids.add(step.id);
  }
  if (listed.length > 24)
    throw new OffshiftError(
      `A run holds at most 24 steps; this start lists ${listed.length}. Drop or merge steps`,
    );
  return listed
    .map(({ id, title, phase }) => ({ id, title, phase, state: "todo" as const }))
    .toSorted((a, b) => phases.indexOf(a.phase) - phases.indexOf(b.phase));
}

/** Pure transition; the caller supplies canonical tree status and a host-owned source revision. */
export function transition(
  current: OffshiftRun | undefined,
  request: OffshiftRequest,
  context: Context,
): OffshiftRun {
  if (request.action === "get" || request.action === "list" || request.action === "playbooks")
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
      ...(request.playbook ? { playbook: request.playbook } : {}),
      steps: startSteps(request),
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
  if (current.blocker)
    throw new OffshiftError(
      `Resolve the recorded blocker first: call resume with runId "${current.id}", version ${current.version} and the decision in note`,
    );
  if (request.action === "revise") return revise(current, next, request.criterion, request.note);
  if (request.action === "step") return markStep(current, next, request);
  if (request.action === "evidence") return record(current, next, request.evidence, context);
  const from = phases.indexOf(current.phase),
    to = phases.indexOf(request.phase);
  // Returning to implementation/verification is necessary after review findings or source edits.
  if (to > from + 1 || to === from)
    throw new OffshiftError(
      from + 1 < phases.length
        ? `Advance one phase at a time: the next is ${phases[from + 1]}; or return to an earlier phase`
        : "The run is in delivery; return to an earlier phase to repair",
    );
  const open = to > from ? todo(current, current.phase) : [];
  if (open.length)
    throw new OffshiftError(
      `Finish ${current.phase} first: ${open.length} step${open.length === 1 ? "" : "s"} to do (${open.map((step) => step.id).join(", ")}). Call step for each: done with what you observed, or skipped with the reason`,
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
 * Marks one step. Skipping needs its reason. A step of a later phase waits for that phase, so
 * the run's phase stays the honest place in the procedure.
 */
function markStep(
  current: OffshiftRun,
  next: OffshiftRun,
  request: Extract<OffshiftRequest, { action: "step" }>,
): OffshiftRun {
  const step = current.steps.find((item) => item.id === request.stepId);
  if (!step)
    throw new OffshiftError(
      current.steps.length
        ? `No step ${request.stepId} in this run; its steps are ${current.steps.map((item) => item.id).join(", ")}`
        : "This run has no steps; start a run with a playbook or steps to track them",
    );
  if (phases.indexOf(step.phase) > phases.indexOf(current.phase))
    throw new OffshiftError(
      `Step ${step.id} belongs to ${step.phase}; advance there first (the run is in ${current.phase})`,
    );
  if (request.state === "skipped" && !request.note)
    throw new OffshiftError(`Skipping ${step.id} needs a note with the reason`);
  const marked: OffshiftStep = {
    id: step.id,
    title: step.title,
    phase: step.phase,
    state: request.state,
    ...(request.note ? { note: request.note } : {}),
  };
  return OffshiftRun.parse({
    ...next,
    steps: current.steps.map((item) => (item.id === step.id ? marked : item)),
    note: `Step ${step.id} ${request.state}`,
  });
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

/**
 * Records a batch of checks as one write: each names a required criterion and kind once, at the
 * current revision, or nothing is recorded. A check replaces the earlier one of its kind.
 */
function record(
  current: OffshiftRun,
  next: OffshiftRun,
  batch: readonly OffshiftEvidenceInput[],
  context: Context,
): OffshiftRun {
  const seen = new Set<string>();
  for (const evidence of batch) {
    const key = `${evidence.criterionId}:${evidence.kind}`;
    const criterion = current.criteria.find((item) => item.id === evidence.criterionId);
    if (!criterion || !criterion.requiredKinds.includes(evidence.kind))
      throw new OffshiftError(
        `Evidence ${key} does not match a required criterion/kind; nothing was recorded. Call get with runId "${current.id}" and use a criterion id with one of its requiredKinds`,
      );
    if (seen.has(key))
      throw new OffshiftError(
        `Evidence ${key} appears twice; send one result per criterion and kind. Nothing was recorded`,
      );
    seen.add(key);
    if (evidence.revision !== context.revision)
      throw new OffshiftError(
        `Source changed since verification; nothing was recorded. Call get with runId "${current.id}", repeat the checks, then record evidence with the revision get returns`,
      );
  }
  return OffshiftRun.parse({
    ...next,
    evidence: [
      ...current.evidence.filter((item) => !seen.has(`${item.criterionId}:${item.kind}`)),
      ...batch.map((evidence) => ({ ...evidence, recordedAt: context.now, by: context.caller })),
    ],
  });
}
