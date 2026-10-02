import { OrchestrationFact, type OrchestrationState, type OrchestrationLane } from "@ace/protocol";
import {
  addLane,
  clearChecks,
  phase,
  reject,
  start,
  terminal,
  validateClock,
  type Context,
  type Mutation,
  type Transition,
} from "./state.ts";
import { cancelAll, cancelLane, fail, finish, reconcile, updateStatus } from "./lifecycle.ts";

function overBudget(s: OrchestrationState, now: number) {
  const b = s.input.template.budget;
  return now - s.startedAt >= b.durationMs || s.usage.tokens >= b.tokens || s.usage.cost >= b.cost;
}
function invalidate(m: Mutation, lane: OrchestrationLane) {
  lane.threadDone = false;
  delete lane.artifact;
  clearChecks(m, lane);
}
function reopen(m: Mutation, lane: OrchestrationLane) {
  if (!terminal(lane.phase)) return;
  const wasUnsuccessful = lane.phase !== "succeeded";
  phase(m, lane, "working");
  delete lane.endedAt;
  if (m.state.winner === lane.id) {
    m.state.mergeRequested = false;
    if (m.state.mergeStatus === "pending") {
      for (const [id, entry] of Object.entries(m.state.intents))
        if (entry.effect.type === "merge") delete m.state.intents[id];
      m.state.mergeStatus = "none";
    }
    delete m.state.winner;
  }
  if (lane.parentId) {
    const parent = m.state.lanes[lane.parentId];
    if (parent) {
      reopen(m, parent);
      parent.children++;
      clearChecks(m, parent);
      if (wasUnsuccessful) parent.failedChildren--;
      if (parent.phase !== "cancelling") phase(m, parent, "joining");
    }
  }
  if (m.state.stopReason) cancelLane(m, lane);
  else if (overBudget(m.state, m.ctx.now)) cancelAll(m, "budget_exhausted");
}
/** Mutates owned state, like @ace/core. Callers commit state + events + intents atomically. */
export function apply(state: OrchestrationState, input: unknown, ctx: Context): Transition {
  validateClock(ctx);
  const fact = OrchestrationFact.parse(input);
  const result: Transition = { events: [], intents: [] };
  const m: Mutation = { state, ctx, result };
  if (
    (!state.stopReason || state.stopReason === "winner") &&
    (state.open > 0 || state.mergeStatus === "pending") &&
    overBudget(state, ctx.now)
  )
    cancelAll(m, "budget_exhausted");
  if (fact.type === "ack") {
    delete state.intents[fact.intentId];
  } else if (fact.type === "cancel") {
    if (state.open > 0 || state.mergeStatus === "pending") cancelAll(m, "cancelled");
  } else if (fact.type === "spawn") {
    const parent = state.lanes[fact.parentId];
    const receipt = `${fact.parentId}:${fact.attempt}:${fact.requestId}`;
    if (Object.hasOwn(state.spawnReceipts, receipt)) {
      updateStatus(m);
      return result;
    }
    if (
      state.input.template.kind !== "coordinator" ||
      !parent ||
      parent.attempt !== fact.attempt ||
      terminal(parent.phase) ||
      parent.phase === "cancelling" ||
      state.stopReason
    )
      reject(m, "spawn_not_allowed");
    else if (parent.depth >= state.input.template.budget.maxDepth) reject(m, "depth_limit");
    else if (Object.keys(state.lanes).length >= state.input.template.budget.maxLanes)
      reject(m, "lane_limit");
    else {
      const child = addLane(m, fact.spec, fact.prompt, 0, parent);
      state.spawnReceipts[receipt] = child.id;
      start(m, child);
      if (parent.threadDone) {
        clearChecks(m, parent);
        phase(m, parent, "joining");
      }
    }
  } else if (fact.type === "pick") {
    const lane = state.lanes[fact.laneId];
    if (
      state.stopReason === "budget_exhausted" ||
      state.stopReason === "cancelled" ||
      lane?.phase !== "succeeded" ||
      !lane.artifact ||
      state.mergeStatus === "pending" ||
      state.mergeStatus === "applied"
    )
      reject(m, "winner_not_available");
    else {
      state.winner = lane.id;
      if (state.mergeStatus === "failed") state.mergeStatus = "none";
      result.events.push({
        type: "orchestration.winner",
        orchestrationId: state.id,
        runId: state.runId,
        laneId: lane.id,
      });
      cancelAll(m, "winner", lane.id);
      state.mergeRequested = fact.merge;
    }
  } else if ("laneId" in fact) {
    const lane = state.lanes[fact.laneId];
    if (!lane || lane.attempt !== fact.attempt) {
      updateStatus(m);
      return result;
    }
    if (fact.type === "usage") {
      // Provider usage is cumulative per attempt, so reconnect replay cannot charge twice.
      const tokens = Math.max(lane.attemptUsage.tokens, fact.usage.tokens);
      const cost = Math.max(lane.attemptUsage.cost, fact.usage.cost);
      state.usage.tokens = Math.min(
        Number.MAX_SAFE_INTEGER,
        state.usage.tokens + tokens - lane.attemptUsage.tokens,
      );
      state.usage.cost = Math.min(
        Number.MAX_SAFE_INTEGER,
        state.usage.cost + cost - lane.attemptUsage.cost,
      );
      lane.usage.tokens = Math.min(
        Number.MAX_SAFE_INTEGER,
        lane.usage.tokens + tokens - lane.attemptUsage.tokens,
      );
      lane.usage.cost = Math.min(
        Number.MAX_SAFE_INTEGER,
        lane.usage.cost + cost - lane.attemptUsage.cost,
      );
      lane.attemptUsage = { tokens, cost };
      if ((!state.stopReason || state.stopReason === "winner") && overBudget(state, ctx.now))
        cancelAll(m, "budget_exhausted");
    } else if (fact.type === "bound" && lane.phase !== "queued") {
      if (
        (lane.threadId !== undefined && lane.threadId !== fact.threadId) ||
        (lane.worktree !== undefined && lane.worktree !== fact.worktree)
      )
        reject(m, "binding_conflict");
      else {
        lane.threadId = fact.threadId;
        lane.worktree = fact.worktree;
        if (lane.phase === "starting") phase(m, lane, "working");
      }
    } else if (
      fact.type === "stopped" &&
      lane.phase === "cancelling" &&
      state.intents[fact.intentId]?.effect.type === "cancel" &&
      state.intents[fact.intentId]?.effect.laneId === lane.id
    ) {
      if (lane.children === 0) finish(m, lane, "cancelled");
      else {
        lane.threadDone = true;
      }
    } else if (fact.type === "thread") {
      const status = fact.status.state;
      if (
        status !== "done" &&
        terminal(lane.phase) &&
        (status !== "failed" || lane.phase === "succeeded")
      )
        reopen(m, lane);
      if (!terminal(lane.phase) && lane.phase !== "queued" && lane.phase !== "cancelling") {
        if (status === "failed") fail(m, lane, "thread_failed");
        else if (status === "done") {
          lane.threadDone = true;
          reconcile(m, lane);
        } else {
          if (lane.threadDone) invalidate(m, lane);
          phase(
            m,
            lane,
            ["needs_you", "waiting", "unresponsive"].includes(status) ? "waiting" : "working",
          );
        }
      }
    } else if (
      fact.type === "artifact" &&
      !terminal(lane.phase) &&
      lane.phase !== "cancelling" &&
      lane.phase !== "checking"
    ) {
      lane.artifact = fact.artifact;
      reconcile(m, lane);
    } else if (
      fact.type === "checked" &&
      lane.phase === "checking" &&
      state.intents[fact.intentId]?.effect.type === "check" &&
      state.intents[fact.intentId]?.effect.laneId === lane.id
    ) {
      delete state.intents[fact.intentId];
      lane.checksPassed =
        fact.commandPassed && (!state.input.template.checks.review || fact.reviewPassed === true);
      if (!lane.checksPassed) fail(m, lane, "check_failed");
      else reconcile(m, lane);
    } else if (
      fact.type === "execution.failed" &&
      state.intents[fact.intentId]?.effect.laneId === lane.id &&
      state.intents[fact.intentId]?.effect.type === fact.operation
    ) {
      delete state.intents[fact.intentId];
      if (fact.operation === "merge") state.mergeStatus = "failed";
      else if (lane.phase !== "cancelling" && !terminal(lane.phase)) fail(m, lane, fact.error);
    } else if (
      fact.type === "merged" &&
      state.mergeStatus === "pending" &&
      state.winner === lane.id &&
      state.intents[fact.intentId]?.effect.type === "merge"
    ) {
      delete state.intents[fact.intentId];
      state.mergeStatus = "applied";
      state.safetyCheckpoint = fact.safetyCheckpoint;
      result.events.push({
        type: "orchestration.merged",
        orchestrationId: state.id,
        runId: state.runId,
        laneId: lane.id,
        safetyCheckpoint: fact.safetyCheckpoint,
      });
    }
  }
  updateStatus(m);
  return result;
}
