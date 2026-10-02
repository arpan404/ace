import type { State } from "./schema.ts";

/** The daemon keeps one timer and sends a tick at this deadline. No file polling. */
export function nextDeadline(state: State): number | null {
  if (["paused", "cancelling", "cancelled", "done"].includes(state.phase)) return null;
  const times: number[] = [];
  if (
    state.spec.constraints.deadline !== null &&
    !Object.values(state.gates).some((g) => g.kind === "deadline")
  )
    times.push(state.spec.constraints.deadline);
  for (const lane of Object.values(state.lanes)) {
    if (lane.live && !lane.retiring && ["starting", "working", "migrating"].includes(lane.status))
      times.push(lane.lastActivity + state.spec.constraints.stallAfterMs);
  }
  return times.length ? Math.min(...times) : null;
}
