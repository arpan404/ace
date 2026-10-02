import type { OrchestrationEffect, OrchestrationLane, OrchestrationState } from "@ace/protocol";

/** Shared by replay validation and the thin executor shell. Identity is checked at each boundary. */
export function canExecute(
  state: OrchestrationState,
  lane: OrchestrationLane,
  effect: OrchestrationEffect,
) {
  switch (effect.type) {
    case "start":
      return (
        !state.stopReason &&
        ["starting", "working", "waiting", "collecting", "checking", "joining"].includes(lane.phase)
      );
    case "check":
      return (
        !state.stopReason &&
        lane.phase === "checking" &&
        lane.threadDone &&
        lane.children === 0 &&
        lane.checksPassed === undefined &&
        lane.artifact?.checkpoint === effect.artifact.checkpoint
      );
    case "cancel":
      return state.stopReason !== undefined && lane.phase === "cancelling";
    case "merge":
      return (
        state.stopReason === "winner" &&
        state.mergeRequested &&
        state.mergeStatus === "pending" &&
        state.winner === lane.id &&
        state.open === 0 &&
        lane.phase === "succeeded" &&
        lane.artifact?.checkpoint === effect.checkpoint
      );
  }
}
