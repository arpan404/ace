import {
  OrchestrationCreate,
  type OrchestrationState,
  type OrchestrationLane,
  type OrchestrationFact,
  type OrchestrationArtifact,
} from "@ace/protocol";
import { apply, create, type Context, type Transition } from "./index.ts";
export const artifact: OrchestrationArtifact = {
  checkpoint: "refs/ace/checkpoints/result/1",
  summary: "Changed feature",
  diffRef: "blob:diff",
  tests: { passed: 12, failed: 0, outputRef: "blob:tests" },
};
export function setup(
  kind: OrchestrationCreate["template"]["kind"] = "fanout",
  size = 3,
  overrides: Partial<OrchestrationCreate["template"]["budget"]> = {},
) {
  let counter = 0;
  const ctx: Context = { now: 100, ids: { next: (idKind) => `${idKind}-${++counter}` } };
  const input = OrchestrationCreate.parse({
    workspaceId: "workspace",
    prompt: "Implement requested feature",
    baseRef: "a".repeat(40),
    targetBranch: "main",
    template: {
      kind,
      lanes: Array.from({ length: size }, (_, i) => ({
        provider: ["claude", "codex", "opencode", "cursor"][i % 4],
        model: `model-${i}`,
      })),
      checks: { command: ["bun", "run", "test"] },
      budget: {
        maxLanes: 64,
        maxDepth: 3,
        maxAttempts: 1,
        durationMs: 10000,
        tokens: 10000,
        cost: 100,
        ...overrides,
      },
    },
  });
  const run = create(input, ctx);
  const send = (inputFact: OrchestrationFact) => apply(run.state, inputFact, ctx);
  return {
    state: run.state,
    ctx,
    input,
    initial: run,
    send,
    lanes: Object.values(run.state.lanes),
  };
}
export function fact(lane: OrchestrationLane) {
  return { laneId: lane.id, attempt: lane.attempt };
}
export function complete(
  state: OrchestrationState,
  lane: OrchestrationLane,
  ctx: Context,
  value = artifact,
): Transition {
  apply(state, { type: "artifact", ...fact(lane), artifact: value }, ctx);
  return apply(state, { type: "thread", ...fact(lane), status: { state: "done" } }, ctx);
}
export function check(
  state: OrchestrationState,
  lane: OrchestrationLane,
  ctx: Context,
  passed = true,
): Transition {
  const entry = Object.values(state.intents).find(
    (i) => i.effect.type === "check" && i.effect.laneId === lane.id,
  );
  if (!entry) throw new Error("No pending check");
  return apply(
    state,
    {
      type: "checked",
      ...fact(lane),
      intentId: entry.id,
      commandPassed: passed,
      reviewPassed: true,
    },
    ctx,
  );
}

export function stopFact(
  state: OrchestrationState,
  lane: OrchestrationLane,
): Extract<OrchestrationFact, { type: "stopped" }> {
  const pending = Object.values(state.intents).find(
    (i) => i.effect.type === "cancel" && i.effect.laneId === lane.id,
  );
  if (!pending) throw new Error("No pending cancellation");
  return { type: "stopped", ...fact(lane), intentId: pending.id };
}
