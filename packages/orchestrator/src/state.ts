import {
  OrchestrationCreate,
  OrchestrationId,
  type OrchestrationState,
  type OrchestrationIntent,
  type OrchestrationEvent,
  type OrchestrationLane,
  type LaneSpec,
  type OrchestrationArtifact,
  type OrchestrationEffect,
  type LanePhase,
} from "@ace/protocol";

export interface Context {
  now: number;
  ids: { next(kind: "orchestration" | "run" | "lane" | "intent"): string };
}
export interface Transition {
  events: OrchestrationEvent[];
  intents: OrchestrationIntent[];
}
export interface Mutation {
  state: OrchestrationState;
  ctx: Context;
  result: Transition;
}
export const terminal = (value: LanePhase) =>
  value === "succeeded" || value === "failed" || value === "cancelled";
const waiting = (value: LanePhase) => value === "waiting" || value === "joining";
export function phase(m: Mutation, lane: OrchestrationLane, next: LanePhase) {
  if (lane.phase === next) return;
  m.state.open += Number(!terminal(next)) - Number(!terminal(lane.phase));
  m.state.waiting += Number(waiting(next)) - Number(waiting(lane.phase));
  m.state.succeeded += Number(next === "succeeded") - Number(lane.phase === "succeeded");
  m.state.failed += Number(next === "failed") - Number(lane.phase === "failed");
  lane.phase = next;
  m.result.events.push({
    type: "orchestration.lane",
    orchestrationId: m.state.id,
    runId: m.state.runId,
    laneId: lane.id,
    phase: next,
  });
}
export function intent(m: Mutation, effect: OrchestrationEffect) {
  const entry = { id: nextId(m.ctx, "intent"), effect };
  if (Object.hasOwn(m.state.intents, entry.id)) throw new Error("Duplicate intent ID");
  m.state.intents[entry.id] = entry;
  m.result.intents.push(entry);
}
export function clearChecks(m: Mutation, lane: OrchestrationLane) {
  delete lane.checksPassed;
  for (const [id, entry] of Object.entries(m.state.intents)) {
    if (entry.effect.laneId === lane.id && entry.effect.type === "check")
      delete m.state.intents[id];
  }
}
export function clearLaneIntents(m: Mutation, lane: OrchestrationLane) {
  // At most two intents per lane, bounded by the 64-lane cap. Only slow lifecycle transitions use this.
  for (const [id, entry] of Object.entries(m.state.intents)) {
    if (entry.effect.laneId === lane.id && entry.effect.type !== "merge")
      delete m.state.intents[id];
  }
}
export function start(m: Mutation, lane: OrchestrationLane, input?: OrchestrationArtifact) {
  if (lane.attempt === 1) lane.startedAt = m.ctx.now;
  if (input) lane.input = input;
  phase(m, lane, "starting");
  intent(m, {
    type: "start",
    laneId: lane.id,
    attempt: lane.attempt,
    spec: lane.spec,
    prompt: lane.prompt,
    ...(lane.input ? { input: lane.input } : {}),
  });
}
export function addLane(
  m: Mutation,
  spec: LaneSpec,
  prompt: string,
  stage: number,
  parent?: OrchestrationLane,
) {
  const id = nextId(m.ctx, "lane");
  if (Object.hasOwn(m.state.lanes, id)) throw new Error("Duplicate lane ID");
  const lane: OrchestrationLane = {
    id,
    spec,
    prompt,
    stage,
    depth: parent ? parent.depth + 1 : 0,
    ...(parent ? { parentId: parent.id } : {}),
    phase: "queued",
    attempt: 1,
    startedAt: m.ctx.now,
    threadDone: false,
    children: 0,
    failedChildren: 0,
    usage: { tokens: 0, cost: 0 },
    attemptUsage: { tokens: 0, cost: 0 },
  };
  m.state.lanes[id] = lane;
  m.state.open++;
  if (parent) parent.children++;
  return lane;
}
export function create(input: unknown, ctx: Context): { state: OrchestrationState } & Transition {
  const parsed = OrchestrationCreate.parse(input);
  return initialize(nextId(ctx, "orchestration"), parsed, ctx);
}

export function rerun(
  previous: OrchestrationState,
  ctx: Context,
): { state: OrchestrationState } & Transition {
  if (previous.open !== 0 || previous.mergeStatus === "pending")
    throw new Error("run_still_active");
  return initialize(previous.id, OrchestrationCreate.parse(previous.input), ctx);
}

function initialize(
  id: string,
  parsed: OrchestrationCreate,
  ctx: Context,
): { state: OrchestrationState } & Transition {
  validateClock(ctx);
  const state: OrchestrationState = {
    id,
    runId: nextId(ctx, "run"),
    input: parsed,
    startedAt: ctx.now,
    status: "running",
    lanes: Object.create(null),
    intents: Object.create(null),
    spawnReceipts: Object.create(null),
    open: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    usage: { tokens: 0, cost: 0 },
    mergeRequested: false,
    mergeStatus: "none",
  };
  const result: Transition = { events: [], intents: [] };
  const m = { state, ctx, result };
  parsed.template.lanes.forEach((spec, stage) => {
    const prompt =
      parsed.template.kind === "pipeline" ? pipelinePrompt(stage, parsed.prompt) : parsed.prompt;
    const lane = addLane(m, spec, prompt, stage);
    if (parsed.template.kind !== "pipeline" || stage === 0) start(m, lane);
  });
  result.events.push({
    type: "orchestration.status",
    orchestrationId: state.id,
    runId: state.runId,
    status: state.status,
  });
  return { state, ...result };
}
export function reject(m: Mutation, reason: string) {
  m.result.events.push({
    type: "orchestration.rejected",
    orchestrationId: m.state.id,
    runId: m.state.runId,
    reason,
  });
}

function pipelinePrompt(stage: number, prompt: string) {
  const instruction =
    stage === 0
      ? "Implement the task. Return a checkpoint, summary and test results."
      : stage === 1
        ? "Review the input checkpoint and test results. Return a checkpoint and a summary of issues for the fix stage."
        : "Fix the issues in the input review artifact. Return a checkpoint, summary and test results.";
  return `${instruction}\n\nTask:\n${prompt}`;
}

function nextId(ctx: Context, kind: Parameters<Context["ids"]["next"]>[0]) {
  return OrchestrationId.parse(ctx.ids.next(kind));
}
export function validateClock(ctx: Context) {
  if (!Number.isSafeInteger(ctx.now) || ctx.now < 0) throw new Error("Invalid injected clock");
}
