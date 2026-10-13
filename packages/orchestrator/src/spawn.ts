import { SpawnAgentRequest, type OrchestrationState } from "@ace/protocol";
import { apply } from "./reduce.ts";
import type { Context } from "./state.ts";

/** Pure lane spawn. The executor binds the caller to its authenticated lane and attempt. */
export function spawnAgent(
  state: OrchestrationState,
  caller: { laneId: string; attempt: number },
  input: unknown,
  ctx: Context,
) {
  const request = SpawnAgentRequest.parse(input);
  const result = apply(
    state,
    { type: "spawn", parentId: caller.laneId, attempt: caller.attempt, ...request },
    ctx,
  );
  const laneId = state.spawnReceipts[`${caller.laneId}:${caller.attempt}:${request.requestId}`];
  return { ...result, ...(laneId ? { laneId } : {}) };
}
