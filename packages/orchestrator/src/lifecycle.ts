import type { OrchestrationLane } from "@ace/protocol";
import { clearLaneIntents, intent, phase, start, terminal, type Mutation } from "./state.ts";

export function cancelAll(
  m: Mutation,
  reason: "cancelled" | "budget_exhausted" | "winner",
  except?: string,
) {
  m.state.stopReason = reason;
  m.state.mergeRequested = false;
  if (m.state.mergeStatus === "pending") {
    for (const [id, entry] of Object.entries(m.state.intents))
      if (entry.effect.type === "merge") delete m.state.intents[id];
    m.state.mergeStatus = "none";
  }
  for (const lane of Object.values(m.state.lanes)) {
    if (lane.id === except || terminal(lane.phase) || lane.phase === "cancelling") continue;
    cancelLane(m, lane);
  }
}
/** Revived work gets a fresh cancellation intent; an existing cancellation keeps its receipt. */
export function cancelLane(m: Mutation, lane: OrchestrationLane) {
  if (lane.phase === "cancelling") return;
  if (lane.phase === "queued") finish(m, lane, "cancelled");
  else {
    clearLaneIntents(m, lane);
    lane.threadDone = false;
    phase(m, lane, "cancelling");
    intent(m, { type: "cancel", laneId: lane.id, attempt: lane.attempt });
  }
}
export function finish(
  m: Mutation,
  lane: OrchestrationLane,
  outcome: "succeeded" | "failed" | "cancelled",
) {
  if (terminal(lane.phase)) return;
  clearLaneIntents(m, lane);
  phase(m, lane, outcome);
  lane.endedAt = m.ctx.now;
  if (lane.parentId) {
    const parent = m.state.lanes[lane.parentId];
    if (!parent) throw new Error("Missing parent");
    parent.children--;
    if (outcome !== "succeeded") parent.failedChildren++;
    if (parent.phase === "cancelling" && parent.threadDone && parent.children === 0)
      finish(m, parent, "cancelled");
    else reconcile(m, parent);
  }
  if (outcome === "succeeded" && m.state.input.template.kind === "race" && !m.state.winner) {
    m.state.winner = lane.id;
    m.result.events.push({
      type: "orchestration.winner",
      orchestrationId: m.state.id,
      runId: m.state.runId,
      laneId: lane.id,
    });
    cancelAll(m, "winner", lane.id);
  }
  if (m.state.input.template.kind === "pipeline" && !m.state.stopReason) {
    if (outcome === "failed") cancelAll(m, "cancelled");
    if (outcome === "succeeded") {
      const next = Object.values(m.state.lanes).find((l) => l.stage === lane.stage + 1);
      if (next?.phase === "queued") start(m, next, lane.artifact);
    }
  }
}
export function fail(m: Mutation, lane: OrchestrationLane, error: string) {
  lane.error = error;
  if (lane.children > 0) {
    lane.checksPassed = false;
    lane.threadDone = true;
    phase(m, lane, "joining");
    return;
  }
  if (
    !m.state.stopReason &&
    lane.failedChildren === 0 &&
    lane.attempt < m.state.input.template.budget.maxAttempts
  ) {
    clearLaneIntents(m, lane);
    lane.attempt++;
    lane.threadDone = false;
    lane.attemptUsage = { tokens: 0, cost: 0 };
    delete lane.threadId;
    delete lane.worktree;
    delete lane.artifact;
    delete lane.checksPassed;
    start(m, lane);
    return;
  }
  finish(m, lane, "failed");
}
export function reconcile(m: Mutation, lane: OrchestrationLane) {
  if (terminal(lane.phase) || lane.phase === "cancelling" || !lane.threadDone) return;
  if (lane.children > 0) {
    phase(m, lane, "joining");
    return;
  }
  if (lane.failedChildren > 0 || lane.checksPassed === false) {
    fail(m, lane, lane.error ?? "descendant_failed");
    return;
  }
  if (!lane.artifact) {
    phase(m, lane, "collecting");
    return;
  }
  if (lane.checksPassed === true) {
    finish(m, lane, "succeeded");
    return;
  }
  if (lane.phase !== "checking") {
    phase(m, lane, "checking");
    intent(m, { type: "check", laneId: lane.id, attempt: lane.attempt, artifact: lane.artifact });
  }
}
export function updateStatus(m: Mutation) {
  const s = m.state;
  if (s.open === 0 && s.mergeRequested && s.mergeStatus === "none" && s.winner) {
    const lane = s.lanes[s.winner];
    if (lane?.artifact) {
      s.mergeStatus = "pending";
      intent(m, {
        type: "merge",
        laneId: lane.id,
        attempt: lane.attempt,
        checkpoint: lane.artifact.checkpoint,
      });
    }
  }
  const next = runStatus(s);
  if (next !== s.status) {
    s.status = next;
    m.result.events.push({
      type: "orchestration.status",
      orchestrationId: s.id,
      runId: s.runId,
      status: next,
    });
  }
}

export function runStatus(state: Mutation["state"]): Mutation["state"]["status"] {
  if (state.open > 0)
    return state.stopReason ? "cancelling" : state.waiting > 0 ? "waiting" : "running";
  else if (state.mergeStatus === "pending") return "running";
  else if (state.mergeStatus === "failed") return "failed";
  else if (state.stopReason === "budget_exhausted") return "budget_exhausted";
  else if (state.stopReason === "winner" && !state.winner)
    return state.failed > 0 ? "failed" : "cancelled";
  else if (state.stopReason === "cancelled") return state.failed > 0 ? "failed" : "cancelled";
  else if (
    state.winner ||
    (state.succeeded > 0 && state.input.template.kind === "fanout") ||
    (state.failed === 0 && state.succeeded > 0)
  )
    return "succeeded";
  else return "failed";
}
