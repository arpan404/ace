import { aceWaitFact } from "./ace-waits.ts";
import { goalChange } from "./goal-change.ts";
import type { StatementSync } from "node:sqlite";
import { FactBatch, type Fact, type ThreadState, type IdSource } from "@ace/core";
import type { EventPayload } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { Snapshot } from "./persistence.ts";
import type { TransitionReadiness } from "./transition-readiness.ts";
import { coalesceFacts } from "./delta-batch.ts";
import { capFact } from "./raw.ts";
import { retireEndedTurnInputs } from "./stale-inputs.ts";
import { bindConsumedInput, bindStartedRun } from "./transcript-inputs.ts";
import { shapeProviderError, structuredError } from "./provider-errors.ts";
import { forkReplaySource, inheritedReplay } from "./fork-replay.ts";
export interface FactPorts {
  ids: IdSource;
  snapshot: Snapshot | undefined;
  readiness: TransitionReadiness;
  admission: {
    has: StatementSync;
    mark: StatementSync;
    ack: StatementSync;
    correlated: StatementSync;
  };
  opening: boolean;
  recoveryAcknowledged(): boolean;
}
/** Fold provider evidence and durable acknowledgements inside the repository transaction. */
export function foldProviderFacts(
  repo: EngineRepository,
  state: ThreadState,
  facts: Fact[],
  now: number,
  ports: FactPorts,
  generation?: number,
): ThreadState {
  const id = state.threadId;
  ports.snapshot?.begin();
  const batch = new FactBatch(
    state,
    ports.snapshot ? { deadline: ports.snapshot.deadline() } : undefined,
  );
  let continuationStarted = false;
  const replayedFrom = ports.opening ? forkReplaySource(repo, id) : undefined;
  const events = coalesceFacts(facts).flatMap((input) => {
    if (repo.interactions.obsolete(id, input)) return [];
    if (replayedFrom) input = inheritedReplay(input, replayedFrom, state);
    if (
      (input.type === "item.upsert" || input.type === "item.reconciled") &&
      input.agent === (state.rootKey ?? "root") &&
      input.draft.type === "notice" &&
      input.draft.code === "thread_title"
    ) {
      const thread = repo.store.getThread(id);
      const title = input.draft.title?.trim();
      if (
        title &&
        (thread?.titleSource === "provisional" ||
          thread?.titleSource === "provider" ||
          (!thread?.titleSource && thread?.title === "New thread"))
      )
        repo.store.appendEvents(
          id,
          [{ type: "thread.updated", title, titleSource: "provider" }],
          now,
        );
      return [];
    }
    if (input.type === "goal.updated") {
      if (input.agent !== (state.rootKey ?? "root")) return [];
      const goal = goalChange(repo.store.getThread(id)?.goal, input.goal);
      if (goal !== undefined) repo.store.appendEvents(id, [{ type: "thread.updated", goal }], now);
      return [];
    }
    if (input.type === "input.consumed") {
      if (ports.opening || input.agent !== (state.rootKey ?? "root")) return [];
      return input.nativeInputIds.flatMap((nativeId) => {
        const key = repo.inputs.keyFor(id, nativeId);
        return key ? bindConsumedInput(repo, state, key, generation, now) : [];
      });
    }
    const queue = input.type === "turn.started" ? repo.queue.get(id) : undefined;
    if (
      input.type === "turn.started" &&
      input.agent === (state.rootKey ?? "root") &&
      queue?.trigger &&
      ports.recoveryAcknowledged()
    )
      input = { ...input, trigger: queue.trigger };
    if (ports.opening && input.type === "item.upsert" && input.draft.type === "tool_call")
      input = { ...input, type: "item.reconciled" };
    const correlated = repo.inputs.correlate(
      id,
      input,
      state.rootKey ?? "root",
      ports.opening ? undefined : generation,
    );
    if (!correlated) return [];
    let fact = repo.attributeAction(state, repo.aceInputs.attribute(id, correlated));
    if (
      ((fact.type === "item.upsert" || fact.type === "item.reconciled") &&
        fact.draft.type === "notice") ||
      (fact.type === "turn.ended" && fact.error) ||
      (fact.type === "process.exited" && fact.message)
    )
      fact = shapeProviderError(fact, state.config.provider, repo.session(id).model);
    const previousItem =
      fact.type === "item.upsert" || fact.type === "item.reconciled"
        ? state.items[fact.item]
        : undefined;
    fact = capFact(
      (raw) => repo.store.capRaw(raw, id),
      fact,
      previousItem?.type === "tool_call" ? previousItem.call : undefined,
    );
    // A provider's own wake input (a finished shell, a child's result) is classified by its
    // adapter, which holds the native evidence. The run's trigger is no evidence: Claude writes
    // other notes into a woken run too (an image's scale, an interruption), and they are not it.
    if (fact.type === "turn.started" && fact.agent === (state.rootKey ?? "root")) {
      const pending = repo.pending.awaiting(id);
      if (
        pending &&
        (pending.kind === "thread.create" || pending.kind === "thread.send") &&
        pending.trigger &&
        ["user", "queue", "unknown"].includes(fact.trigger)
      )
        fact = { ...fact, trigger: pending.trigger };
    }
    if (fact.type === "turn.ended" && fact.agent === (state.rootKey ?? "root")) {
      const record = state.agents[fact.agent];
      const runId = fact.nativeTurnId ? record?.nativeRuns?.[fact.nativeTurnId] : record?.activeRun;
      const run = runId ? state.runs[runId] : undefined;
      if (run && ["spawn", "parent_agent", "subagent_result", "schedule"].includes(run.trigger))
        fact = { ...fact, trigger: run.trigger };
    }
    if (fact.type === "interaction.closed" && fact.state === "resolved") {
      const interaction = Object.hasOwn(state.interactions, fact.interaction)
        ? state.interactions[fact.interaction]
        : undefined;
      const answer = interaction ? repo.answer(interaction.id) : undefined;
      if (answer?.payload.type === "interaction.resolve")
        fact = {
          ...fact,
          resolution: answer.payload.resolution,
          resolvedBy: answer.deviceId,
        };
    }
    const snapshot = ports.snapshot;
    const finish = snapshot?.prepare(fact) ?? (() => {});
    try {
      const emitted = batch.apply(fact, {
        now,
        ids:
          fact.type === "item.upsert" && fact.item.startsWith("input:")
            ? { next: (kind) => (kind === "item" ? fact.item : ports.ids.next(kind)) }
            : ports.ids,
        ...(fact.type === "turn.ended"
          ? {
              resolvingInteractions: repo.pending.resolvingInteractions(id),
            }
          : {}),
      });
      // The provider's own echo of an input arrives in the run that took it.
      if (
        !ports.opening &&
        generation !== undefined &&
        (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
        fact.item.startsWith("input:") &&
        fact.agent === (state.rootKey ?? "root") &&
        fact.draft.type === "message" &&
        fact.draft.role === "user" &&
        state.agents[fact.agent]?.activeRun
      )
        emitted.push(...bindConsumedInput(repo, state, fact.item, generation, now));
      const waiting = aceWaitFact(state, fact);
      if (waiting) emitted.push(...batch.apply(waiting, { now, ids: ports.ids }));
      repo.interactions.opened(state, fact, generation);
      for (const event of emitted)
        if (event.type === "interaction.closed")
          for (const settled of repo.interactions.closed(state, event))
            emitted.push(...batch.apply(settled, { now, ids: ports.ids }));
      repo.interactions.observe(id, emitted);
      if (fact.type === "turn.ended" && fact.error)
        for (const event of emitted)
          if (event.type === "run.ended") {
            event.error = fact.error;
            const run = state.runs[event.runId];
            if (run) run.error = fact.error;
          }
      if (
        fact.type === "turn.started" &&
        (fact.trigger === "restart" || fact.trigger === "limit_resume") &&
        emitted.some((event) => event.type === "run.started")
      )
        continuationStarted = true;
      if (fact.type === "item.delta" && emitted.some((event) => event.type === "item.delta"))
        snapshot?.delta(fact);
      snapshot?.remember(fact, emitted);
      if (fact.type === "tick") ports.readiness.refreshBlocked(state);
      return emitted;
    } finally {
      finish();
    }
  });
  events.push(...batch.flush());
  for (const event of events)
    if (event.type === "agent.status" && event.status.state === "failed") {
      const error = structuredError(event.status.error, state.config.provider);
      event.status = { ...event.status, error };
      const key = state.indexes.agentKeysById[event.agentId];
      const record = key ? state.agents[key] : undefined;
      if (record) {
        record.agent.status = event.status;
        if (record.lastError) record.lastError = error;
        if (record.processSettledStatus?.state === "failed")
          record.processSettledStatus = event.status;
        const run = record.lastRun ? state.runs[record.lastRun] : undefined;
        if (run?.state === "failed") {
          run.error = error;
          for (const end of events)
            if (end.type === "run.ended" && end.runId === run.id) end.error = error;
        }
      }
    }

  // Admission-based providers transfer queue ownership before a run starts.
  // Persist the acknowledgement policy in the existing per-thread record store,
  // so a later run cannot acknowledge the next, unrelated engine input.
  const root = state.agents[state.rootKey ?? ""]?.agent.id;
  const inputUpdates: EventPayload[] = [];
  let admittedUncertainty = false;
  for (const event of events) {
    const rootStarted =
      event.type === "run.started" &&
      !ports.opening &&
      event.run.agentId === root &&
      [
        "user",
        "queue",
        "unknown",
        "spawn",
        "parent_agent",
        "subagent_result",
        "schedule",
        "restart",
        "limit_resume",
      ].includes(event.run.trigger);
    const pending =
      event.type === "input.admitted" || rootStarted
        ? (repo.pending.awaiting(id) ??
          (rootStarted ? repo.pending.uncertainContinuation(id) : undefined))
        : undefined;
    const commandId =
      event.type === "input.admitted" ? (event.commandId ?? pending?.commandId) : undefined;
    const key = commandId ? `input:${commandId}` : undefined;
    const item = key ? state.items[key] : undefined;
    if (
      key &&
      item?.type === "message" &&
      item.agentId === root &&
      event.type === "input.admitted"
    ) {
      const updated = { ...item, nativeId: event.nativeInputId };
      state.items[key] = updated;
      inputUpdates.push({ type: "item.updated", item: updated });
    }
    // The run takes what the engine handed this session and no run has taken yet.
    if (rootStarted && event.type === "run.started")
      inputUpdates.push(...bindStartedRun(repo, state, event.run.id, generation));
    const admitted = event.type === "input.admitted" && event.agentId === root && !ports.opening;
    if (admitted) ports.admission.mark.run(id);
    const started = rootStarted && !ports.admission.has.get(id);
    const acknowledged =
      event.type === "input.admitted" && admitted && event.commandId !== undefined
        ? ports.admission.correlated.all(id, event.commandId)
        : admitted || started
          ? started && pending && repo.pending.uncertainContinuation(id)?.id === pending.id
            ? ports.admission.correlated.all(id, pending.commandId)
            : ports.admission.ack.all(id, id)
          : [];
    for (const row of acknowledged) {
      repo.queue.prune(Number(row.id));
      const noticeKey = `intent:${row.id}`;
      const notice = state.items[noticeKey];
      if (notice?.type === "notice" && notice.code === "delivery_uncertain") {
        const confirmed = {
          ...notice,
          level: "info" as const,
          code: "delivery_confirmed",
          title: "Message received",
          text: "The provider confirmed this message",
        };
        state.items[noticeKey] = confirmed;
        inputUpdates.push({ type: "item.updated", item: confirmed });
      }
    }
    if (acknowledged.length) admittedUncertainty = true;
  }
  events.push(...inputUpdates);
  if (continuationStarted && repo.queue.get(id).trigger) {
    repo.queue.set(id, { continuation: null, trigger: null }, now);
    repo.pending.finishContinuation(id);
  }
  if (admittedUncertainty || continuationStarted) {
    const queue = repo.queue.get(id);
    if (queue.reason === "uncertain" && !repo.queue.hasUncertain(id))
      repo.queue.set(
        id,
        !queue.limited && !queue.continuation ? { paused: false, reason: null } : {},
        now,
      );
  }
  // A finished root turn settles the inputs its session never confirmed: no later run can.
  if (
    generation !== undefined &&
    !ports.opening &&
    events.some((event) => event.type === "run.ended" && state.runs[event.runId]?.agentId === root)
  )
    retireEndedTurnInputs(repo, id, generation, now);
  ports.snapshot?.updateDeadlines(facts, events, now);
  repo.save(state, events, now);
  repo.observe?.(state, facts, events, now);
  return state;
}
