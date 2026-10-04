import { RunId, type EventPayload, type Run } from "@ace/protocol";
import type { Fact } from "./facts.ts";
import type { AgentRecord, ApplyContext, ThreadState } from "./state.ts";
import { dictionary } from "./state.ts";
import { emit, get, put } from "./emit.ts";
import { ensureAgent, announceAgentBranch } from "./tree.ts";
import { cancelOpenWork } from "./cleanup.ts";

type Started = Extract<Fact, { type: "turn.started" }>;
type Ended = Extract<Fact, { type: "turn.ended" }>;

function matchingRun(state: ThreadState, record: AgentRecord, nativeId: string): Run | undefined {
  const id = record.nativeRuns && get(record.nativeRuns, nativeId);
  return id === undefined ? undefined : get(state.runs, id);
}

function storeRun(state: ThreadState, record: AgentRecord, run: Run): void {
  put(state.runs, run.id, run);
  if (run.nativeId === undefined) return;
  record.nativeRuns ??= dictionary();
  put(record.nativeRuns, run.nativeId, run.id);
}

export function startTurn(
  state: ThreadState,
  fact: Started,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  const record = ensureAgent(state, fact.agent, ctx, events);
  const active = record.activeRun ? get(state.runs, record.activeRun) : undefined;
  // Replayed native boundaries must not create runs or reopen completed ones.
  if (fact.nativeTurnId !== undefined && matchingRun(state, record, fact.nativeTurnId)) return;
  if (active && fact.nativeTurnId === undefined) return;
  if (!active && record.lastRun) announceAgentBranch(state, fact.agent, events);
  if (active) {
    endTurn(
      state,
      {
        type: "turn.ended",
        agent: fact.agent,
        outcome: "interrupted",
        ...(active.nativeId === undefined ? {} : { nativeTurnId: active.nativeId }),
      },
      ctx,
      events,
    );
  }
  const run: Run = {
    id: RunId.parse(ctx.ids.next("run")),
    threadId: state.threadId,
    agentId: record.agent.id,
    trigger: fact.trigger,
    state: "active",
    startedAt: ctx.now,
    ...(fact.nativeTurnId === undefined ? {} : { nativeId: fact.nativeTurnId }),
  };
  storeRun(state, record, run);
  record.activeRun = run.id;
  delete record.processSettledStatus;
  record.activity = "starting_turn";
  delete record.detail;
  delete record.wakeUntil;
  delete record.retry;
  state.hasRun = true;
  emit(events, { type: "run.started", run });
}

export function endTurn(
  state: ThreadState,
  fact: Ended,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  const record = ensureAgent(state, fact.agent, ctx, events);
  const active = record.activeRun ? get(state.runs, record.activeRun) : undefined;
  let run =
    fact.nativeTurnId === undefined ? active : matchingRun(state, record, fact.nativeTurnId);
  if (run && run.state !== "active") {
    if (fact.trigger !== undefined && run.trigger !== fact.trigger) {
      run.trigger = fact.trigger;
      emit(events, {
        type: "run.ended",
        runId: run.id,
        state: run.state,
        endedAt: run.endedAt ?? ctx.now,
        trigger: fact.trigger,
      });
    }
    return;
  }
  if (!run) {
    if (fact.nativeTurnId === undefined && record.lastRun) return;
    // A partial stream can contain the end boundary without the start.
    run = {
      id: RunId.parse(ctx.ids.next("run")),
      threadId: state.threadId,
      agentId: record.agent.id,
      trigger: fact.trigger ?? "unknown",
      state: "active",
      startedAt: ctx.now,
      ...(fact.nativeTurnId === undefined ? {} : { nativeId: fact.nativeTurnId }),
    };
    storeRun(state, record, run);
    state.hasRun = true;
    emit(events, { type: "run.started", run });
  }
  run.state = fact.outcome;
  run.endedAt = ctx.now;
  if (fact.trigger !== undefined) run.trigger = fact.trigger;
  emit(events, {
    type: "run.ended",
    runId: run.id,
    state: fact.outcome,
    endedAt: ctx.now,
    ...(fact.trigger === undefined ? {} : { trigger: fact.trigger }),
  });
  // A delayed end for an older native turn cannot terminate the current turn.
  if (active && active.id !== run.id) return;
  delete record.processSettledStatus;
  delete record.activeRun;
  delete record.retry;
  record.lastRun = run.id;
  record.lastOutcomeOrder = ++state.outcomeOrder;
  if (fact.outcome === "completed") record.lastSuccessfulOutcomeOrder = record.lastOutcomeOrder;
  if (fact.outcome === "failed") {
    record.lastError = structuredClone(fact.error ?? { kind: "provider", message: "turn failed" });
  } else {
    delete record.lastError;
  }
  cancelOpenWork(
    state,
    record.agent.id,
    ctx.now,
    events,
    fact.outcome === "interrupted" ? undefined : ctx.resolvingInteractions,
  );
}
