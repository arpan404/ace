import {
  OffshiftRun,
  type OffshiftAuthor,
  type OffshiftPerson,
  type OffshiftPersonChange,
} from "@ace/protocol/offshift";
import type { OffshiftPersonOperation } from "@ace/protocol/offshift-person";
import {
  OffshiftConflict,
  OffshiftError,
  advancePhase,
  phases,
  revise,
  startSteps,
  type Observation,
} from "./workflow.ts";

/*
 * The person's changes to a run. They are fenced on the version the person saw, recorded as the
 * person's with their device, and listed in the run so the agent reads them before its next
 * write. Pure.
 */

export interface PersonContext extends Observation {
  threadId: OffshiftRun["threadId"];
  person: OffshiftPerson;
  /** The thread's agent, which a run the person starts is measured against for independence. */
  agent: OffshiftAuthor | null;
  now: number;
}

type Change = Exclude<OffshiftPersonOperation, { action: "start" | "get" }>;

/** The run after the person's change, or a refusal naming why. */
export function personTransition(
  current: OffshiftRun | undefined,
  op: Exclude<OffshiftPersonOperation, { action: "get" }>,
  context: PersonContext,
): OffshiftRun {
  if (op.action === "start") {
    if (current) throw new OffshiftError(`A run named ${op.runId} already exists`);
    return OffshiftRun.parse({
      id: op.runId,
      threadId: context.threadId,
      outcome: op.outcome,
      endpoint: op.endpoint,
      criteria: op.criteria,
      owner: context.agent,
      startedBy: context.person,
      ...(op.playbook ? { playbook: op.playbook } : {}),
      steps: startSteps({ playbook: op.playbook }),
      phase: "plan",
      version: 0,
      blocker: null,
      note: "Run started by the person",
      evidence: [],
      createdAt: context.now,
      updatedAt: context.now,
    });
  }
  if (!current) throw new OffshiftError("This run no longer exists");
  if (current.ended) throw new OffshiftError("This run has ended");
  if (current.version !== op.expectedVersion)
    throw new OffshiftConflict("The run changed since you opened it");
  const next: OffshiftRun = { ...current, version: current.version + 1, updatedAt: context.now };
  const { run, summary } = apply(current, next, op, context);
  const entry: OffshiftPersonChange = {
    version: next.version,
    at: context.now,
    by: context.person,
    summary,
  };
  return OffshiftRun.parse({ ...run, personChanges: [...current.personChanges, entry].slice(-16) });
}

function apply(
  current: OffshiftRun,
  next: OffshiftRun,
  op: Change,
  context: PersonContext,
): { run: OffshiftRun; summary: string } {
  switch (op.action) {
    case "step":
      return step(current, next, op);
    case "evidence":
      return evidence(current, next, op, context);
    case "revise":
      return {
        run: revise(current, next, op.criterion, "Criterion revised by the person"),
        summary: `Revised criterion ${op.criterion.id}: ${clip(op.criterion.description)}`,
      };
    case "advance":
      if (current.blocker)
        throw new OffshiftError("Resume the run first: the agent recorded a blocker");
      return {
        run: advancePhase(current, next, op.phase, "Advanced by the person", context),
        summary: `Moved the run to ${op.phase}`,
      };
    case "resume":
      if (!current.blocker) throw new OffshiftError("Nothing blocks this run");
      return {
        run: { ...next, blocker: null, note: op.note },
        summary: `Resolved the blocker: ${clip(op.note)}`,
      };
    case "end":
      return {
        run: {
          ...next,
          ended: {
            at: context.now,
            by: context.person,
            note: op.note ?? "Ended by the person",
          },
          note: op.note ?? "Ended by the person",
        },
        summary: op.note ? `Ended the run: ${clip(op.note)}` : "Ended the run",
      };
  }
}

/** Done, or back to to do. A later phase's step waits for that phase, as it does for agents. */
function step(
  current: OffshiftRun,
  next: OffshiftRun,
  op: Extract<Change, { action: "step" }>,
): { run: OffshiftRun; summary: string } {
  const found = current.steps.find((item) => item.id === op.stepId);
  if (!found) throw new OffshiftError("This run has no such step");
  if (op.state === "done" && phases.indexOf(found.phase) > phases.indexOf(current.phase))
    throw new OffshiftError(`This step belongs to ${found.phase}; move the run there first`);
  const marked = {
    id: found.id,
    title: found.title,
    phase: found.phase,
    state: op.state,
    ...(op.state === "done" && op.note ? { note: op.note } : {}),
  };
  return {
    run: {
      ...next,
      steps: current.steps.map((item) => (item.id === found.id ? marked : item)),
      note: `Step ${found.id} ${op.state} by the person`,
    },
    summary: `Marked step ${found.id} ${op.state === "done" ? "done" : "not done"}`,
  };
}

/** The person's own check, bound to the revision they looked at. */
function evidence(
  current: OffshiftRun,
  next: OffshiftRun,
  op: Extract<Change, { action: "evidence" }>,
  context: PersonContext,
): { run: OffshiftRun; summary: string } {
  const criterion = current.criteria.find((item) => item.id === op.criterionId);
  if (!criterion || !criterion.requiredKinds.includes(op.kind))
    throw new OffshiftError("That criterion doesn't need this kind of check");
  if (op.revision !== context.revision)
    throw new OffshiftError("The source changed since you looked; check it again");
  return {
    run: {
      ...next,
      evidence: [
        ...current.evidence.filter(
          (item) => !(item.criterionId === op.criterionId && item.kind === op.kind),
        ),
        {
          criterionId: op.criterionId,
          kind: op.kind,
          result: op.result,
          revision: op.revision,
          action: "Checked by the person",
          artifact: op.link ?? "Recorded in ace",
          note: op.note,
          recordedAt: context.now,
          by: context.person,
        },
      ],
    },
    summary: `Recorded a ${op.result === "pass" ? "passing" : "failing"} ${op.kind} check for ${op.criterionId}: ${clip(op.note)}`,
  };
}

function clip(text: string): string {
  const points = Array.from(text);
  return points.length > 200 ? `${points.slice(0, 199).join("")}…` : text;
}
