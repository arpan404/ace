import type { StatementSync } from "node:sqlite";
import { FactBatch, type Fact, type ThreadState, type IdSource } from "@ace/core";
import type { EventPayload, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { Snapshot } from "./persistence.ts";
import type { TransitionReadiness } from "./transition-readiness.ts";
import { coalesceFacts } from "./delta-batch.ts";
import { capFact } from "./raw.ts";
import { shapeProviderError, structuredError } from "./provider-errors.ts";
export interface FactPorts {
  ids: IdSource;
  snapshot: Snapshot | undefined;
  readiness: TransitionReadiness;
  admission: { has: StatementSync; mark: StatementSync; ack: StatementSync; correlated: StatementSync };
  opening: boolean;
  recoveryAcknowledged: boolean;
}
/** Fold provider evidence and durable acknowledgements inside the repository transaction. */
export function foldProviderFacts(repo: EngineRepository, state: ThreadState, facts: Fact[], now: number, ports: FactPorts, generation?: number): ThreadState {
  const id = state.threadId;
        ports.snapshot?.begin();
        const batch = new FactBatch(state);
        let continuationStarted = false;
        const events = coalesceFacts(facts).flatMap((input) => {
          if (repo.interactions.obsolete(id, input)) return [];
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
                (!thread?.titleSource && thread?.title === "New thread"))
            )
              repo.store.appendEvents(
                id,
                [{ type: "thread.updated", title, titleSource: "provider" }],
                now,
              );
            return [];
          }
          const queue = input.type === "turn.started" ? repo.queue.get(id) : undefined;
          if (
            input.type === "turn.started" &&
            input.agent === (state.rootKey ?? "root") &&
            queue?.trigger &&
            ports.recoveryAcknowledged
          )
            input = { ...input, trigger: queue.trigger };
          const correlated = repo.inputs.correlate(id, input, state.rootKey ?? "root", generation);
          if (!correlated) return [];
          let fact = capFact(
            (raw) => repo.store.capRaw(raw, id),
            shapeProviderError(
              correlated,
              state.config.provider,
            ),
          );
          if (
            (fact.type === "item.upsert" || fact.type === "item.reconciled") &&
            fact.agent === (state.rootKey ?? "root") &&
            fact.draft.type === "message" &&
            fact.draft.role === "user" &&
            !fact.draft.origin
          ) {
            const runId = state.agents[fact.agent]?.activeRun;
            const trigger = runId ? state.runs[runId]?.trigger : undefined;
            if (trigger === "background_completion" || trigger === "subagent_result")
              fact = {
                ...fact,
                draft: { ...fact.draft, origin: { kind: trigger }, synthetic: true },
              };
          }
          if (fact.type === "turn.started" && fact.agent === (state.rootKey ?? "root")) {
            const pending = repo.pending.awaiting(id);
            if (
              pending &&
              (pending.kind === "thread.create" || pending.kind === "thread.send") &&
              pending.trigger
            )
              fact = { ...fact, trigger: pending.trigger };
          }
          if (fact.type === "turn.ended" && fact.agent === (state.rootKey ?? "root")) {
            const record = state.agents[fact.agent];
            const runId = fact.nativeTurnId
              ? record?.nativeRuns?.[fact.nativeTurnId]
              : record?.activeRun;
            const run = runId ? state.runs[runId] : undefined;
            if (
              run &&
              ["spawn", "parent_agent", "subagent_result", "schedule"].includes(run.trigger)
            )
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
            repo.interactions.opened(state, fact, generation);
            for (const event of [...emitted])
              if (event.type === "interaction.closed")
                for (const settled of repo.interactions.closed(state, event))
                  emitted.push(...batch.apply(settled, { now, ids: ports.ids }));
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
        repo.interactions.observe(id, events);
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
        for (const event of events) {
          const pending =
            event.type === "input.admitted" ||
            (event.type === "run.started" && event.run.agentId === root)
              ? repo.pending.awaiting(id)
              : undefined;
          const commandId =
            event.type === "input.admitted"
              ? (event.commandId ?? pending?.commandId)
              : event.type === "run.started" && event.run.agentId === root
                ? pending?.commandId
                : undefined;
          const key = commandId ? `input:${commandId}` : undefined;
          const item = key ? state.items[key] : undefined;
          if (
            key &&
            item?.type === "message" &&
            item.agentId === root &&
            (event.type === "run.started" || event.type === "input.admitted")
          ) {
            const updated = {
              ...item,
              ...(event.type === "run.started"
                ? { runId: event.run.id }
                : { nativeId: event.nativeInputId }),
            };
            state.items[key] = updated;
            inputUpdates.push({ type: "item.updated", item: updated });
          }
          const admitted =
            event.type === "input.admitted" && event.agentId === root && !ports.opening;
          if (admitted) ports.admission.mark.run(id);
          const started =
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
            ].includes(event.run.trigger) &&
            !ports.admission.has.get(id);
          const acknowledged =
            event.type === "input.admitted" && admitted && event.commandId !== undefined
              ? ports.admission.correlated.all(id, event.commandId)
              : admitted || started
                ? ports.admission.ack.all(id, id)
                : [];
          for (const row of acknowledged) repo.queue.prune(Number(row.id));
        }
        events.push(...inputUpdates);
        if (continuationStarted && repo.queue.get(id).trigger) {
          repo.queue.set(id, { continuation: null, trigger: null }, now);
          repo.pending.finishContinuation(id);
        }
        ports.snapshot?.updateDeadlines(facts, events, now);
        repo.save(state, events, now);
        repo.observe?.(state, facts, events, now);
        return state;
}
