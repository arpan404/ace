import { z } from "zod";
import {
  OrchestrationFact,
  type OrchestrationState,
  type OrchestrationIntent,
  type OrchestrationLane,
  type OrchestrationArtifact,
  type OrchestrationCreate,
} from "@ace/protocol";

export interface ExecutionRequest {
  intentId: string;
  orchestrationId: string;
  runId: string;
  input: OrchestrationCreate;
  lane: OrchestrationLane;
}
/** Engine-owned operations. Every operation MUST deduplicate intentId durably. */
export interface Executor {
  start(request: ExecutionRequest & { artifact?: OrchestrationArtifact }): Promise<unknown>;
  check(request: ExecutionRequest & { artifact: OrchestrationArtifact }): Promise<unknown>;
  cancel(request: ExecutionRequest): Promise<void>;
  merge(request: ExecutionRequest & { checkpoint: string }): Promise<unknown>;
}
const Bound = z.object({ threadId: z.string().min(1), worktree: z.string().min(1).max(512) });
const Checked = z.object({ commandPassed: z.boolean(), reviewPassed: z.boolean().optional() });
const Merged = z.object({ safetyCheckpoint: z.string().min(1).max(512) });
/** Execute one persisted intent with backpressure. Failures remain pending for reconciliation.
 * Cancellation failures never claim a thread has stopped. The host owns retry/timeout policy.
 */
export async function execute(
  state: OrchestrationState,
  entry: OrchestrationIntent,
  executor: Executor,
) {
  const persisted = state.intents[entry.id];
  if (!persisted) return [];
  const effect = persisted.effect;
  const lane = state.lanes[effect.laneId];
  if (!lane || lane.attempt !== effect.attempt) return [];
  if (effect.type === "check" && lane.phase !== "checking") return [];
  if (effect.type === "cancel" && lane.phase !== "cancelling") return [];
  if (
    effect.type === "merge" &&
    (state.mergeStatus !== "pending" || state.winner !== lane.id || state.open !== 0)
  )
    return [];
  const request: ExecutionRequest = {
    intentId: entry.id,
    orchestrationId: state.id,
    runId: state.runId,
    input: state.input,
    lane,
  };
  const identity = { laneId: lane.id, attempt: effect.attempt };
  let fact: OrchestrationFact;
  switch (effect.type) {
    case "start":
      fact = OrchestrationFact.parse({
        type: "bound",
        ...identity,
        ...Bound.parse(
          await executor.start({ ...request, ...(effect.input ? { artifact: effect.input } : {}) }),
        ),
      });
      break;
    case "check":
      fact = OrchestrationFact.parse({
        type: "checked",
        ...identity,
        intentId: entry.id,
        ...Checked.parse(await executor.check({ ...request, artifact: effect.artifact })),
      });
      break;
    case "cancel":
      await executor.cancel(request);
      fact = { type: "stopped", ...identity };
      break;
    case "merge":
      fact = OrchestrationFact.parse({
        type: "merged",
        ...identity,
        intentId: entry.id,
        ...Merged.parse(await executor.merge({ ...request, checkpoint: effect.checkpoint })),
      });
  }
  return [fact, OrchestrationFact.parse({ type: "ack", intentId: entry.id })];
}
