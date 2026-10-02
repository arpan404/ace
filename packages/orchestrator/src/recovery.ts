import { OrchestrationId, OrchestrationState, type OrchestrationLane } from "@ace/protocol";
import { canExecute } from "./execution-policy.ts";
import { runStatus } from "./lifecycle.ts";
import { terminal, type Transition } from "./state.ts";

/** Parse durable state, checking the bounded indexes once at startup, never on a hot path. */
export function recover(input: unknown): { state: OrchestrationState } & Transition {
  const state = OrchestrationState.parse(input);
  let open = 0,
    waiting = 0,
    succeeded = 0,
    failed = 0;
  const children = new Map<string, number>();
  const failedChildren = new Map<string, number>();
  const lanes = Object.values(state.lanes);
  if (lanes.length > state.input.template.budget.maxLanes || lanes.length === 0)
    throw new Error("Invalid lane count");
  for (const [key, lane] of Object.entries(state.lanes)) {
    if (key !== lane.id || lane.depth > state.input.template.budget.maxDepth)
      throw new Error("Invalid lane identity or depth");
    if (!terminal(lane.phase)) open++;
    if (lane.phase === "waiting" || lane.phase === "joining") waiting++;
    if (lane.phase === "succeeded") succeeded++;
    if (lane.phase === "failed") failed++;
    if (lane.parentId) {
      const parent: OrchestrationLane | undefined = state.lanes[lane.parentId];
      if (!parent || parent.depth + 1 !== lane.depth) throw new Error("Invalid parent tree");
      if (!terminal(lane.phase)) children.set(parent.id, (children.get(parent.id) ?? 0) + 1);
      else if (lane.phase !== "succeeded")
        failedChildren.set(parent.id, (failedChildren.get(parent.id) ?? 0) + 1);
    } else if (lane.depth !== 0) throw new Error("Invalid root depth");
  }
  for (const lane of lanes) {
    if (
      lane.children !== (children.get(lane.id) ?? 0) ||
      lane.failedChildren !== (failedChildren.get(lane.id) ?? 0)
    )
      throw new Error("Invalid child count");
    if (state.stopReason && !terminal(lane.phase) && lane.phase !== "cancelling")
      throw new Error("Invalid stopped lane phase");
    if ((lane.threadId === undefined) !== (lane.worktree === undefined))
      throw new Error("Incomplete binding");
    if (terminal(lane.phase) && lane.children > 0) throw new Error("Unfinished descendants");
    if (
      lane.phase === "succeeded" &&
      (!lane.threadDone || !lane.artifact || lane.checksPassed !== true)
    )
      throw new Error("Unchecked success");
  }
  const receiptedChildren = new Set<string>();
  for (const [key, childId] of Object.entries(state.spawnReceipts)) {
    const [parentId, attemptText, requestId, extra] = key.split(":");
    const parent = parentId ? state.lanes[parentId] : undefined;
    const child = state.lanes[childId];
    const attempt = Number(attemptText);
    if (
      state.input.template.kind !== "coordinator" ||
      extra !== undefined ||
      !OrchestrationId.safeParse(parentId).success ||
      !OrchestrationId.safeParse(requestId).success ||
      !parent ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > parent.attempt ||
      String(attempt) !== attemptText ||
      !child ||
      child.parentId !== parentId ||
      receiptedChildren.has(childId)
    )
      throw new Error("Invalid spawn receipt");
    receiptedChildren.add(childId);
  }
  for (const lane of lanes)
    if (lane.parentId && !receiptedChildren.has(lane.id)) throw new Error("Missing spawn receipt");
  if (
    open !== state.open ||
    waiting !== state.waiting ||
    succeeded !== state.succeeded ||
    failed !== state.failed
  )
    throw new Error("Invalid lifecycle counters");
  if (state.status !== runStatus(state)) throw new Error("Invalid run status");
  if (state.winner && state.lanes[state.winner]?.phase !== "succeeded")
    throw new Error("Invalid winner");
  const operations = new Set<string>();
  for (const [key, entry] of Object.entries(state.intents)) {
    const lane = state.lanes[entry.effect.laneId];
    if (key !== entry.id || !lane || lane.attempt !== entry.effect.attempt)
      throw new Error("Invalid intent ownership");
    if (!canExecute(state, lane, entry.effect)) throw new Error("Invalid intent phase");
    const operation = `${lane.id}:${entry.effect.type}`;
    if (operations.has(operation)) throw new Error("Duplicate intent operation");
    operations.add(operation);
  }
  for (const lane of lanes) {
    const required =
      lane.phase === "starting"
        ? "start"
        : lane.phase === "checking"
          ? "check"
          : lane.phase === "cancelling" && !lane.threadDone
            ? "cancel"
            : undefined;
    if (required && !operations.has(`${lane.id}:${required}`))
      throw new Error("Missing lifecycle intent");
  }
  if (
    state.mergeStatus === "pending" &&
    (!state.winner || !operations.has(`${state.winner}:merge`))
  )
    throw new Error("Missing merge intent");
  return { state, events: [], intents: Object.values(state.intents) };
}
