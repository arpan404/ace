import type {
  OffshiftEvidenceKind,
  OffshiftPhase,
  OffshiftPlaybookId,
  OffshiftRunCard,
} from "@ace/protocol/offshift";
import type { OffshiftClientResult, OffshiftPersonOperation } from "@ace/protocol/offshift-person";
import { offshiftPhaseNames } from "@ace/projection/offshift-mark";
import { offshiftKindNames } from "./offshift.ts";

/*
 * What the person can do to a thread's Offshift run, and the operations their edits become.
 * Web and the native apps draw the same controls from this, with the same words. Each change
 * carries the card's version, so an agent write in between is refused, never overwritten. Pure.
 */

const phases: readonly OffshiftPhase[] = ["plan", "implement", "verify", "review", "delivery"];
export const offshiftKinds: readonly OffshiftEvidenceKind[] = [
  "automated",
  "source",
  "ui",
  "human",
  "manual",
];

export interface OffshiftPhaseMove {
  phase: OffshiftPhase;
  /** "Move to Verify", "Back to Implement". */
  label: string;
  /** Why it can't be done now; the control shows disabled with this as its reason. */
  disabled?: string;
}
export interface OffshiftStepControl {
  id: string;
  /** "Mark done" for a step to do; "Mark not done" for one done or skipped. */
  label: string;
  state: "done" | "todo";
}
export interface OffshiftCriterionControl {
  id: string;
  /** The kinds a check can be recorded for, in the criterion's order. */
  kinds: { kind: OffshiftEvidenceKind; label: string }[];
}
export interface OffshiftControls {
  runId: string;
  version: number;
  revision: string;
  steps: OffshiftStepControl[];
  forward: OffshiftPhaseMove | null;
  back: OffshiftPhaseMove | null;
  /** The agent recorded a blocker the person can resolve. */
  resume: boolean;
  criteria: OffshiftCriterionControl[];
}

/** The controls for an open run; none once it has ended. */
export function offshiftControls(card: OffshiftRunCard): OffshiftControls | null {
  if (card.ended) return null;
  const at = phases.indexOf(card.phase);
  const nextPhase = phases[at + 1];
  const previous = phases[at - 1];
  const todo = card.steps.filter((step) => step.state === "todo").length;
  const forwardReason = card.blocker
    ? "Resolve the blocker first"
    : todo
      ? `${todo === 1 ? "1 step" : `${todo} steps`} still to do`
      : nextPhase === "delivery" && card.pendingCount > 0
        ? `${card.pendingCount === 1 ? "1 check" : `${card.pendingCount} checks`} still needed`
        : undefined;
  return {
    runId: card.id,
    version: card.version,
    revision: card.revision,
    steps: card.steps.map((step) =>
      step.state === "todo"
        ? { id: step.id, label: "Mark done", state: "done" }
        : { id: step.id, label: "Mark not done", state: "todo" },
    ),
    forward: nextPhase
      ? {
          phase: nextPhase,
          label: `Move to ${offshiftPhaseNames[nextPhase]}`,
          ...(forwardReason ? { disabled: forwardReason } : {}),
        }
      : null,
    back: previous
      ? {
          phase: previous,
          label: `Back to ${offshiftPhaseNames[previous]}`,
          ...(card.blocker ? { disabled: "Resolve the blocker first" } : {}),
        }
      : null,
    resume: card.blocker !== null,
    criteria: card.criteria.map((criterion) => ({
      id: criterion.id,
      kinds: criterion.evidence.map((item) => ({
        kind: item.kind,
        label: offshiftKindNames[item.kind],
      })),
    })),
  };
}

type Operation<A extends OffshiftPersonOperation["action"]> = Extract<
  OffshiftPersonOperation,
  { action: A }
>;
export type Drafted<T> = { ok: true; op: T } | { ok: false; reason: string };

export interface OffshiftCriterionDraft {
  description: string;
  kinds: readonly OffshiftEvidenceKind[];
  independent?: boolean;
}
export interface OffshiftStartDraft {
  goal: string;
  /** Where the run ends; blank: reported in the thread. */
  doneWhen: string;
  criteria: readonly OffshiftCriterionDraft[];
  playbook?: OffshiftPlaybookId | undefined;
}

/** A run id unique enough per thread: the time and a random suffix, both supplied. */
export function offshiftRunId(now: number, random: string): string {
  const suffix = random.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "run";
  return `person-${now.toString(36)}-${suffix}`;
}

/** A run to start, or what is missing. Blank criteria lines are dropped. */
export function startOperation(
  draft: OffshiftStartDraft,
  runId: string,
): Drafted<Operation<"start">> {
  const goal = draft.goal.trim();
  if (!goal) return { ok: false, reason: "Add a goal" };
  const criteria: { description: string; kinds: readonly OffshiftEvidenceKind[]; independent?: true }[] =
    [];
  for (const item of draft.criteria) {
    const description = item.description.trim();
    if (!description) continue;
    if (item.independent) criteria.push({ description, kinds: item.kinds, independent: true });
    else criteria.push({ description, kinds: item.kinds });
  }
  if (!criteria.length) return { ok: false, reason: "Add at least one criterion" };
  if (criteria.length > 64) return { ok: false, reason: "A run holds at most 64 criteria" };
  if (criteria.some((item) => !item.kinds.length))
    return { ok: false, reason: "Choose how each criterion is checked" };
  const tooLong = goal.length > 4096 || criteria.some((item) => item.description.length > 4096);
  if (tooLong) return { ok: false, reason: "Keep each line under 4,096 characters" };
  const built: Operation<"start">["criteria"] = [];
  for (const [index, item] of criteria.entries()) {
    const entry = {
      id: `c${index + 1}`,
      description: item.description,
      requiredKinds: [...new Set(item.kinds)],
    };
    built.push(item.independent ? Object.assign(entry, { independent: true as const }) : entry);
  }
  const op = {
    action: "start" as const,
    runId,
    outcome: goal,
    endpoint: draft.doneWhen.trim() || "Reported in this thread",
    criteria: built,
  };
  return {
    ok: true,
    op: draft.playbook ? Object.assign(op, { playbook: draft.playbook }) : op,
  };
}

export interface OffshiftEvidenceDraft {
  criterionId: string;
  kind: OffshiftEvidenceKind;
  result: "pass" | "fail";
  note: string;
  link: string;
}

/** The person's check on a criterion, bound to the version and revision on the card. */
export function evidenceOperation(
  card: OffshiftRunCard,
  draft: OffshiftEvidenceDraft,
): Drafted<Operation<"evidence">> {
  const note = draft.note.trim();
  if (!note) return { ok: false, reason: "Say what you checked" };
  const link = draft.link.trim();
  return {
    ok: true,
    op: {
      action: "evidence",
      runId: card.id,
      expectedVersion: card.version,
      criterionId: draft.criterionId,
      kind: draft.kind,
      result: draft.result,
      revision: card.revision,
      note,
      ...(link ? { link } : {}),
    },
  };
}

/** A criterion replaced in place; its earlier checks are dropped by the daemon. */
export function reviseOperation(
  card: OffshiftRunCard,
  id: string,
  draft: OffshiftCriterionDraft,
): Drafted<Operation<"revise">> {
  const description = draft.description.trim();
  if (!description) return { ok: false, reason: "Describe the criterion" };
  if (!draft.kinds.length) return { ok: false, reason: "Choose how it is checked" };
  return {
    ok: true,
    op: {
      action: "revise",
      runId: card.id,
      expectedVersion: card.version,
      criterion: {
        id,
        description,
        requiredKinds: [...new Set(draft.kinds)],
        ...(draft.independent ? { independent: true } : {}),
      },
    },
  };
}

/** A new criterion's id: the next free `cN` after the run's own. */
export function nextCriterionId(ids: readonly string[]): string {
  const taken = new Set(ids);
  let n = ids.length + 1;
  while (taken.has(`c${n}`)) n++;
  return `c${n}`;
}

/** Mark a step done (with what was seen) or back to do. */
export function stepOperation(
  card: OffshiftRunCard,
  stepId: string,
  state: "done" | "todo",
  note: string,
): Drafted<Operation<"step">> {
  const trimmed = note.trim();
  if (trimmed.length > 1024) return { ok: false, reason: "Keep the note under 1,024 characters" };
  const op = {
    action: "step" as const,
    runId: card.id,
    expectedVersion: card.version,
    stepId,
    state,
  };
  return {
    ok: true,
    op: state === "done" && trimmed ? Object.assign(op, { note: trimmed }) : op,
  };
}

/** Move the run one phase forward or back to an earlier one. */
export function advanceOperation(
  card: OffshiftRunCard,
  phase: OffshiftPhase,
): Drafted<Operation<"advance">> {
  return {
    ok: true,
    op: { action: "advance", runId: card.id, expectedVersion: card.version, phase },
  };
}

/** Clear the agent's blocker with the person's decision. */
export function resumeOperation(card: OffshiftRunCard, note: string): Drafted<Operation<"resume">> {
  const trimmed = note.trim();
  if (!trimmed) return { ok: false, reason: "Say how the blocker is resolved" };
  if (trimmed.length > 4096)
    return { ok: false, reason: "Keep each line under 4,096 characters" };
  return {
    ok: true,
    op: { action: "resume", runId: card.id, expectedVersion: card.version, note: trimmed },
  };
}

/** End the run for good, with an optional note. */
export function endOperation(card: OffshiftRunCard, note: string): Drafted<Operation<"end">> {
  const trimmed = note.trim();
  if (trimmed.length > 4096)
    return { ok: false, reason: "Keep each line under 4,096 characters" };
  const op = { action: "end" as const, runId: card.id, expectedVersion: card.version };
  return { ok: true, op: trimmed ? Object.assign(op, { note: trimmed }) : op };
}

/** What a refused change says, in one line with what to do. Undefined when it went through. */
export function offshiftFailure(
  result: Pick<OffshiftClientResult, "ok" | "error" | "message">,
): string | undefined {
  if (result.ok) return undefined;
  switch (result.error) {
    case "conflict":
      return "The run changed while you were editing. Look at it again, then retry.";
    case "forbidden":
      return "This device can't change runs. Pair it with operate access.";
    case "not_found":
      return "This run no longer exists.";
    case "unavailable":
      return "Couldn't reach this thread's workspace. Try again once it's back.";
    default:
      return result.message
        ? `Couldn't change the run. ${result.message}.`
        : "Couldn't change the run.";
  }
}
