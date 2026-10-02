import type { Lane, State } from "./schema.ts";

export function laneDeadline(state: State, lane: Lane): number | null {
  if (
    !lane.live ||
    lane.retiring ||
    Object.values(state.gates).some((g) => g.lane === lane.id && g.kind === "escalation")
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
