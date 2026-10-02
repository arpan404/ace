import type { AgentId, EventPayload } from "@ace/protocol";
import type { ApplyContext, ThreadState } from "./state.ts";
import type { Fact } from "./facts.ts";
import { emit } from "./emit.ts";
import { isSettled } from "./status.ts";
import {
  liveToolKeys,
  pendingInteractionKeys,
  runningTaskKeys,
  refreshItemIndex,
  refreshInteractionIndex,
  refreshTaskIndex,
} from "./indexes.ts";

export function cancelOpenWork(
  state: ThreadState,
  agentId: AgentId,
  now: number,
  events: EventPayload[],
): void {
  const backgroundItems = new Set(
    runningTaskKeys(state).flatMap((key) => {
      const task = state.tasks[key]!;
      return task.toolCallId === undefined ? [] : [task.toolCallId];
    }),
  );
  for (const key of liveToolKeys(state, agentId)) {
    const item = state.items[key]!;
    if (item.agentId !== agentId || item.type !== "tool_call") continue;
    if (!["pending", "running", "awaiting_approval"].includes(item.call.status)) continue;
    if (backgroundItems.has(item.id)) continue;
    item.call.status = "cancelled";
    item.call.error = "turn ended without completion";
    item.call.endedAt = now;
    item.complete = true;
    refreshItemIndex(state, key);
    emit(events, { type: "item.updated", item });
  }
  for (const key of pendingInteractionKeys(state, agentId)) {
    const interaction = state.interactions[key]!;
    if (interaction.agentId !== agentId || !interaction.blocking || interaction.state !== "pending")
      continue;
    interaction.state = "cancelled";
    interaction.closedAt = now;
    refreshInteractionIndex(state, key);
    emit(events, {
      type: "interaction.closed",
      interactionId: interaction.id,
      state: "cancelled",
      closedAt: now,
    });
  }
}

export function exitProcess(
  state: ThreadState,
  fact: Extract<Fact, { type: "process.exited" }>,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  if (state.processExit) return;
  state.processExit = {
    deliberate: fact.deliberate,
    ...(fact.message === undefined ? {} : { message: fact.message }),
    unsettled: Object.entries(state.agents)
      .filter(([, record]) => !isSettled(record.agent.status))
      .map(([key]) => key),
  };
  for (const key of pendingInteractionKeys(state)) {
    const interaction = state.interactions[key]!;
    if (interaction.state !== "pending") continue;
    interaction.state = "expired";
    interaction.closedAt = ctx.now;
    refreshInteractionIndex(state, key);
    emit(events, {
      type: "interaction.closed",
      interactionId: interaction.id,
      state: "expired",
      closedAt: ctx.now,
    });
  }
  for (const key of runningTaskKeys(state)) {
    const task = state.tasks[key]!;
    if (task.status !== "running") continue;
    task.status = "unknown";
    task.endedAt = ctx.now;
    refreshTaskIndex(state, key);
    emit(events, {
      type: "background_task.updated",
      taskId: task.id,
      status: "unknown",
      endedAt: ctx.now,
    });
  }
  for (const record of Object.values(state.agents)) {
    delete record.disconnectedAt;
    delete record.retry;
    delete record.wakeUntil;
    if (!record.activeRun) {
      if (!isSettled(record.agent.status)) {
        record.processSettledStatus = fact.deliberate
          ? { state: "interrupted" }
          : {
              state: "failed",
              error: { kind: "process_exit", message: fact.message ?? "Provider process exited" },
            };
        record.lastOutcomeOrder = ++state.outcomeOrder;
      }
      continue;
    }
    const run = state.runs[record.activeRun];
    if (run) {
      run.state = fact.deliberate ? "interrupted" : "failed";
      run.endedAt = ctx.now;
      record.lastRun = run.id;
      record.lastOutcomeOrder = ++state.outcomeOrder;
      if (!fact.deliberate)
        record.lastError = {
          kind: "process_exit",
          message: fact.message ?? "provider process exited",
        };
      emit(events, { type: "run.ended", runId: run.id, state: run.state, endedAt: ctx.now });
    }
    delete record.activeRun;
    cancelOpenWork(state, record.agent.id, ctx.now, events);
  }
}
