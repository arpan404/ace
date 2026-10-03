import type { EventPayload } from "@ace/protocol";
import type { Fact } from "./facts.ts";
import type { ApplyContext, ThreadState } from "./state.ts";
import { emit, get, put } from "./emit.ts";
import { ensureAgent, ensureInitialRoot, linkAgent, reconcileLinks, seeAgent } from "./tree.ts";
import { recomputeStatuses } from "./status.ts";
import { reconcileItem } from "./reconciled-item.ts";
import { appendItem, upsertItem } from "./items.ts";
import { startTurn, endTurn } from "./runs.ts";
import { openInteraction, closeInteraction, startBackground, endBackground } from "./entities.ts";
import { exitProcess } from "./cleanup.ts";
import { validateFact } from "./validate.ts";
import { flushNotices, rejectFact } from "./diagnostics.ts";
import { hasUnresponsiveAncestor, transportSignalAt } from "./liveness.ts";

function signal(state: ThreadState, fact: Fact, ctx: ApplyContext, events: EventPayload[]): void {
  if ("agent" in fact && fact.agent !== undefined) {
    ensureAgent(state, fact.agent, ctx, events).lastSignalAt = ctx.now;
  } else if (fact.type === "signal") {
    // A transport heartbeat covers every agent, e.g. OpenCode SSE heartbeats.
    for (const record of Object.values(state.agents)) record.lastSignalAt = ctx.now;
  } else {
    const owner =
      fact.type === "background.ended"
        ? get(state.tasks, fact.task)?.agentId
        : fact.type === "interaction.closed"
          ? get(state.interactions, fact.interaction)?.agentId
          : undefined;
    if (owner !== undefined) {
      const key = get(state.indexes.agentKeysById, owner);
      const record = key === undefined ? undefined : get(state.agents, key);
      if (record) record.lastSignalAt = ctx.now;
    }
  }
}

/** Fold one adapter fact. The caller owns the clock, id sequence and envelope. */
export function apply(state: ThreadState, input: unknown, ctx: ApplyContext): EventPayload[] {
  if (!Number.isSafeInteger(ctx.now) || ctx.now < 0)
    throw new Error("now must be a nonnegative integer");
  if (typeof ctx.ids?.next !== "function") throw new Error("ids.next must be a function");
  const result = validateFact(state, input, ctx.now);
  if ("error" in result) return rejectFact(state, input, result.error, ctx);
  const fact = result.fact;
  const events: EventPayload[] = [];
  ensureInitialRoot(state, ctx, events);
  const transportRecovered =
    state.config.liveness === "transport" &&
    ctx.now - transportSignalAt(state) > state.config.silenceMs;
  if (fact.type !== "tick" && fact.type !== "queue.changed" && fact.type !== "process.exited") {
    state.lastTransportSignalAt = ctx.now;
  }
  signal(state, fact, ctx, events);
  if (fact.type === "item.delta") {
    const changed = appendItem(state, fact, ctx, events);
    if (changed || transportRecovered || hasUnresponsiveAncestor(state, fact.agent)) {
      reconcileLinks(state, ctx, events);
      recomputeStatuses(state, ctx.now, events);
    }
    flushNotices(state, ctx, events);
    return events;
  }
  switch (fact.type) {
    case "agent.disconnected":
      ensureAgent(state, fact.agent, ctx, events).disconnectedAt = ctx.now;
      break;
    case "agent.reconnected":
      delete ensureAgent(state, fact.agent, ctx, events).disconnectedAt;
      break;
    case "agent.seen":
      seeAgent(state, fact, ctx, events);
      break;
    case "agent.linked":
      linkAgent(state, fact, ctx, events);
      break;
    case "turn.started":
      startTurn(state, fact, ctx, events);
      break;
    case "turn.ended":
      endTurn(state, fact, ctx, events);
      if (fact.error?.kind === "quota")
        ensureAgent(state, fact.agent, ctx, events).limited = { message: fact.error.message };
      break;
    case "activity": {
      const record = ensureAgent(state, fact.agent, ctx, events);
      record.activity = fact.activity;
      if (fact.detail === undefined) delete record.detail;
      else record.detail = fact.detail;
      break;
    }
    case "item.upsert":
    case "item.reconciled": {
      const update = fact.type === "item.reconciled" ? reconcileItem : upsertItem;
      const item = update(state, fact.agent, fact.item, fact.draft, ctx, events);
      const record = get(state.agents, fact.agent);
      if (!record?.activeRun || item.runId !== record.activeRun) break;
      if (item.type === "tool_call") {
        record.activity = ["running", "pending", "awaiting_approval"].includes(item.call.status)
          ? "tool"
          : "starting_turn";
      } else if (!item.complete) {
        if (item.type === "reasoning") record.activity = "thinking";
        else if (item.type === "message" && item.role === "assistant")
          record.activity = "responding";
        else if (item.type === "compaction") record.activity = "compacting";
      }
      break;
    }
    case "subagents.waiting":
      put(state.itemLinks, fact.item, {
        ...get(state.itemLinks, fact.item),
        waitingFor: [...fact.targets],
      });
      break;
    case "interaction.opened":
      openInteraction(state, fact, ctx, events);
      break;
    case "interaction.closed":
      closeInteraction(state, fact, ctx, events);
      break;
    case "background.started":
      startBackground(state, fact, ctx, events);
      break;
    case "background.ended":
      endBackground(state, fact, ctx, events);
      break;
    case "retry": {
      const record = ensureAgent(state, fact.agent, ctx, events);
      const { type: _type, agent: _agent, ...retry } = fact;
      record.retry = { ...retry };
      if (fact.on === "rate_limit")
        record.limited = {
          ...(fact.until === undefined ? {} : { until: fact.until }),
          ...(fact.message === undefined ? {} : { message: fact.message }),
        };
      break;
    }
    case "retry.cleared": {
      const record = ensureAgent(state, fact.agent, ctx, events);
      if (!record.retry || record.retry.on === "rate_limit") {
        if (transportRecovered || hasUnresponsiveAncestor(state, fact.agent)) {
          reconcileLinks(state, ctx, events);
          recomputeStatuses(state, ctx.now, events);
        }
        flushNotices(state, ctx, events);
        return events;
      }
      delete record.retry;
      break;
    }
    case "limit.cleared": {
      const record = ensureAgent(state, fact.agent, ctx, events);
      if (record.retry?.on === "rate_limit") delete record.retry;
      delete record.limited;
      break;
    }
    case "wake.expected":
      ensureAgent(state, fact.agent, ctx, events).wakeUntil = fact.until;
      break;
    case "context.sample": {
      const record = ensureAgent(state, fact.agent, ctx, events);
      const { type: _type, agent: _agent, ...sample } = fact;
      emit(events, { type: "context.sampled", agentId: record.agent.id, ...sample });
      break;
    }
    case "usage": {
      const record = ensureAgent(state, fact.agent, ctx, events);
      const { type: _type, agent: _agent, ...usage } = fact;
      emit(events, { type: "usage.updated", agentId: record.agent.id, ...usage });
      break;
    }
    case "process.exited":
      exitProcess(state, fact, ctx, events);
      break;
    case "process.started":
      state.queueSources.provider = 0;
      state.queueCount = state.queueSources.engine;
      delete state.processExit;
      break;
    case "queue.changed": {
      state.queueSources[fact.source ?? "engine"] = fact.count;
      state.queueCount = state.queueSources.engine + state.queueSources.provider;
      break;
    }
    case "signal":
    case "tick":
      break;
  }
  flushNotices(state, ctx, events);
  reconcileLinks(state, ctx, events);
  recomputeStatuses(state, ctx.now, events);
  return events;
}
