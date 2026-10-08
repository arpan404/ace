import type { Lane, State } from "./schema.ts";

export function laneDeadline(state: State, lane: Lane): number | null {
  if (
    !lane.live ||
    Object.values(state.gates).some((g) => g.lane === lane.id && g.kind === "escalation")
  )
    return null;
  if (lane.retiring) return (lane.stopRequestedAt ?? lane.lastActivity) + 30_000;
  if (state.phase === "paused") return null;
  if (
    lane.status === "starting" &&
    Object.values(state.gates).some(
      (g) =>
        ["plan", "budget", "deadline"].includes(g.kind) ||
        g.lane === lane.id ||
        (g.workstream !== null && g.workstream === lane.workstream),
    )
  )
    return null;
  if (lane.status === "migrating" && lane.migrationObservation?.status === "done")
    return !lane.artifact && lane.artifactDeadline !== null
      ? lane.artifactDeadline
      : lane.migrationObservation.at + state.spec.constraints.stallAfterMs;
  if (["starting", "working", "migrating"].includes(lane.status))
    return lane.lastActivity + state.spec.constraints.stallAfterMs;
  if (lane.status === "done" && !lane.artifact)
    return lane.artifactDeadline ?? lane.lastActivity + state.spec.constraints.stallAfterMs;
  return null;
}
