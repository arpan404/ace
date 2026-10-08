import { laneDeadline } from "./liveness.ts";
import type { State } from "./schema.ts";

/** The daemon keeps one timer and sends a tick at this deadline. No file polling. */
export function nextDeadline(state: State): number | null {
  if (["cancelled", "done"].includes(state.phase)) return null;
  const times: number[] = [];
  if (
    state.phase !== "cancelling" &&
    state.phase !== "paused" &&
    state.spec.constraints.deadline !== null &&
    !Object.values(state.gates).some((g) => g.kind === "deadline")
  )
    times.push(state.spec.constraints.deadline);
  for (const lane of Object.values(state.lanes)) {
    const deadline = laneDeadline(state, lane);
    if (deadline !== null) times.push(deadline);
  }
  return times.length ? Math.min(...times) : null;
}
