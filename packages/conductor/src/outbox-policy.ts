import type { Effect, State } from "./schema.ts";

/** User gates stop new scheduling, while cleanup and already-required checks can drain. */
export function executable(state: State, effect: Effect): boolean {
  if (!["launch", "migrate", "merge", "verify", "correct_artifact"].includes(effect.type))
    return true;
  if (state.phase === "cancelling" || state.phase === "cancelled") return true;
  if (state.phase === "paused") return false;
  if (effect.type === "verify") return true;
  if (
    "lane" in effect &&
    (!state.lanes[effect.lane.id]?.live ||
      state.lanes[effect.lane.id]?.retiring ||
      state.lanes[effect.lane.id]?.generation !== effect.lane.generation)
  )
    return true;
  return !Object.values(state.gates).some(
    (gate) =>
      ["budget", "deadline", "plan"].includes(gate.kind) ||
      ("lane" in effect && gate.lane === effect.lane.id) ||
      (gate.workstream !== null &&
        (("lane" in effect && gate.workstream === effect.lane.workstream) ||
          ("workstream" in effect && gate.workstream === effect.workstream))),
  );
}
