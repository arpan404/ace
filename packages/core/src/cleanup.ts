import type { AgentId, EventPayload } from "@ace/protocol";
import type { ApplyContext, ThreadState } from "./state.ts";
import type { Fact } from "./facts.ts";
import { emit } from "./emit.ts";
import { isSettled } from "./status.ts";

export function cancelOpenWork(
  state: ThreadState,
  agentId: AgentId,
  now: number,
  events: EventPayload[],
): void {
  for (const item of Object.values(state.items)) {
    if (item.agentId !== agentId || item.type !== "tool_call") continue;
    if (!["pending", "running", "awaiting_approval"].includes(item.call.status)) continue;
    const background = Object.values(state.tasks).some(
      (task) => task.toolCallId === item.id && task.status === "running",
    );
    if (background) continue;
    item.call.status = "cancelled";
    item.call.error = "turn ended without completion";
    item.call.endedAt = now;
    item.complete = true;
    emit(events, { type: "item.updated", item });
  }
  for (const interaction of Object.values(state.interactions)) {
    if (interaction.agentId !== agentId || !interaction.blocking || interaction.state !== "pending")
      continue;
    interaction.state = "cancelled";
    interaction.closedAt = now;
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
  for (const interaction of Object.values(state.interactions)) {
    if (interaction.state !== "pending") continue;
    interaction.state = "expired";
    interaction.closedAt = ctx.now;
    emit(events, {
      type: "interaction.closed",
      interactionId: interaction.id,
      state: "expired",
      closedAt: ctx.now,
    });
  }
  for (const task of Object.values(state.tasks)) {
    if (task.status !== "running") continue;
    task.status = "unknown";
    task.endedAt = ctx.now;
    emit(events, {
      type: "background_task.updated",
      taskId: task.id,
      status: "unknown",
      endedAt: ctx.now,
    });
  }
  for (const record of Object.values(state.agents)) {
    if (!record.activeRun) continue;
    const run = state.runs[record.activeRun];
    if (run) {
      run.state = fact.deliberate ? "interrupted" : "failed";
      run.endedAt = ctx.now;
      record.lastRun = run.id;
      if (!fact.deliberate)
        record.lastError = {
          kind: "process_exit",
          message: fact.message ?? "provider process exited",
        };
      emit(events, { type: "run.ended", runId: run.id, state: run.state, endedAt: ctx.now });
    }
    delete record.activeRun;
    delete record.retry;
    delete record.wakeUntil;
    cancelOpenWork(state, record.agent.id, ctx.now, events);
  }
}
