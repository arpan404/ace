import { ConductorPlan, type ConductorCommandPayload, type ConductorSpec } from "@ace/protocol";
import {
  clientView,
  executable,
  parseLaneArtifact,
  reduce,
  start,
  type Environment,
} from "@ace/conductor/core";
import type { FakeDeckCard, FakeDeckRun, FakeDeckExecution } from "./types.ts";

function environment(execution: FakeDeckExecution, now: number): Environment {
  return {
    now: () => now,
    id: () => `fake-${++execution.sequence}`,
    agentId: () => `30000000-0000-4000-8000-${String(++execution.sequence).padStart(12, "0")}`,
  };
}
function apply(execution: FakeDeckExecution, input: unknown, now: number) {
  const result = reduce(execution.state, input, environment(execution, now));
  execution.state = result.state;
  execution.pending.push(...result.effects);
}
/** The provider/engine boundary is scripted; all lifecycle decisions use the real reducer. */
function drain(execution: FakeDeckExecution, now: number) {
  for (let count = 0; execution.pending.length && count < 1024; count++) {
    const index = execution.pending.findIndex((effect) => executable(execution.state, effect));
    if (index < 0) break;
    const [effect] = execution.pending.splice(index, 1);
    if (!effect) break;
    if (["done", "cancelled"].includes(execution.state.phase) && effect.type !== "control")
      continue;
    if (effect.type === "launch") {
      const lane = execution.state.lanes[effect.lane.id];
      if (!lane?.live || lane.retiring) continue;
      execution.bindings.push({ ...lane });
      if (execution.bindings.length > 256) execution.bindings.shift();
      if (lane.role === "planner") {
        apply(
          execution,
          {
            type: "artifact",
            laneId: lane.id,
            generation: lane.generation,
            artifact: { kind: "plan", plan: execution.plan },
          },
          now,
        );
        apply(
          execution,
          { type: "status", laneId: lane.id, generation: lane.generation, status: "done", at: now },
          now,
        );
      } else
        apply(
          execution,
          {
            type: "status",
            laneId: lane.id,
            generation: lane.generation,
            status: "working",
            at: now,
          },
          now,
        );
    } else if (effect.type === "correct_artifact") {
      apply(
        execution,
        {
          type: "artifact_correction_started",
          laneId: effect.lane.id,
          generation: effect.lane.generation,
        },
        now,
      );
      execution.corrections.push({ laneId: effect.lane.id, error: effect.error });
      if (execution.corrections.length > 256) execution.corrections.shift();
      apply(
        execution,
        {
          type: "status",
          laneId: effect.lane.id,
          generation: effect.lane.generation,
          status: "working",
          at: now,
        },
        now,
      );
    } else if (
      effect.type === "control" &&
      (effect.action === "force_cancel" || (effect.action === "cancel" && !execution.holdStops))
    ) {
      apply(
        execution,
        {
          type: "status",
          laneId: effect.lane.id,
          generation: effect.lane.generation,
          status: "done",
          at: now,
        },
        now,
      );
    } else if (effect.type === "merge") {
      apply(
        execution,
        {
          type: "merge_result",
          workstream: effect.workstream,
          operationId: effect.id,
          revision: effect.completion.revision,
          conflict: null,
          trivial: false,
        },
        now,
      );
    } else if (effect.type === "verify") {
      if (execution.holdVerification && execution.state.phase !== "cancelling") {
        execution.pending.unshift(effect);
        break;
      }
      apply(
        execution,
        {
          type: "verified",
          workstream: effect.workstream,
          operationId: effect.id,
          revision: effect.revision,
          passed: execution.state.phase !== "cancelling",
          summary: "Scripted verification; failed integration tree restored before settlement",
        },
        now,
      );
    }
  }
}
export function createExecution(
  run: FakeDeckRun,
  spec: ConductorSpec,
  now: number,
): FakeDeckExecution {
  const plan = ConductorPlan.parse({
    summary: run.goal,
    workstreams: run.cards
      .filter((card) => card.kind === "work")
      .map((card) => ({
        id: card.id,
        title: card.title,
        dependencies: card.dependencies,
        priority: 0,
        brief: {
          objective: card.title,
          instructions: card.note,
          acceptance: card.brief?.acceptance ?? [card.title],
          files: [],
          packages: [],
          risks: [],
        },
      })),
  });
  let sequence = 0;
  const result = start(run.id, spec, {
    now: () => now,
    id: () => `fake-${++sequence}`,
    agentId: () => `30000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const execution: FakeDeckExecution = {
    state: result.state,
    sequence,
    plan,
    pending: result.effects,
    corrections: [],
    bindings: [],
  };
  const accounts = spec.constraints.accounts.map((id, index) => ({
    id,
    provider: spec.constraints.providers[index % spec.constraints.providers.length],
    capacity: spec.constraints.maxParallel,
    externalActive: 0,
    quota: 10000,
    resetAt: null,
  }));
  apply(execution, { type: "accounts", accounts }, now);
  drain(execution, now);
  return execution;
}
export function commandExecution(
  execution: FakeDeckExecution,
  payload: Exclude<ConductorCommandPayload, { type: "conductor.start" }>,
  now: number,
): void {
  const input =
    payload.type === "conductor.approve"
      ? { type: "approve", approval: payload.approval }
      : { type: payload.type.slice("conductor.".length) };
  apply(execution, input, now);
  drain(execution, now);
}
export function observeExecution(execution: FakeDeckExecution, input: unknown, now: number): void {
  apply(execution, input, now);
  drain(execution, now);
}

/** Observe a complete provider turn before admitting its correction effects. */
export function artifactExecution(
  execution: FakeDeckExecution,
  laneId: string,
  itemId: string,
  text: string,
  now: number,
): void {
  const lane = execution.state.lanes[laneId];
  if (!lane) throw new Error("fake_execution_missing");
  if (lane.rejectedArtifact === itemId) return;
  const reference = { laneId, generation: lane.generation };
  try {
    apply(
      execution,
      { type: "artifact", ...reference, artifact: parseLaneArtifact(text, lane.role) },
      now,
    );
  } catch (error) {
    apply(
      execution,
      {
        type: "artifact_invalid",
        ...reference,
        itemId,
        error: (error instanceof Error ? error.message : "artifact_validation_failed").slice(
          0,
          8192,
        ),
      },
      now,
    );
  }
  if (!execution.state.lanes[laneId]?.correctionPending)
    apply(execution, { type: "status", ...reference, status: "done", at: now }, now);
  drain(execution, now);
}

const states: Record<string, FakeDeckCard["state"]> = {
  pending: "planned",
  working: "working",
  reviewing: "in_review",
  review_pending: "in_review",
  fix_pending: "fixing",
  conflict_pending: "fixing",
  escalated: "escalated",
  approved: "approved",
  merging: "approved",
  verifying: "approved",
  integrated: "merged",
  declined: "declined",
};
export function executionRun(run: FakeDeckRun, execution: FakeDeckExecution): FakeDeckRun {
  const state = execution.state;
  const gate = Object.values(state.gates)[0];
  return {
    ...run,
    execution,
    phase: state.phase === "running" ? "dealing" : state.phase === "done" ? "merged" : state.phase,
    planApproved: state.planApproved,
    budget: state.spec.constraints.budget,
    spent: state.spent,
    deadline: state.spec.constraints.deadline,
    updatedAt: state.updatedAt,
    gate: gate
      ? { id: gate.id, kind: gate.kind, body: gate.message, cardId: gate.workstream, revision: 1 }
      : null,
    cards: state.plan
      ? run.cards.map((card) => {
          const node = state.nodes[card.id];
          return node
            ? {
                ...card,
                state: states[node.state] ?? "planned",
                round: node.fixRounds + 1,
                question: node.state === "declined" ? null : (card.question ?? null),
              }
            : card;
        })
      : [],
  };
}
export function executionView(execution: FakeDeckExecution) {
  const state = execution.state;
  return clientView(
    state,
    Object.values(state.lanes).filter((lane) => lane.live),
    Object.values(state.nodes),
  );
}
