import { ConductorPlan, ConductorReview, ConductorSpec, reduce, start } from "./index.ts";
import type { Account, Artifact, Effect, Lane, State } from "./index.ts";

export const ROOT = "10000000-0000-4000-8000-000000000000";
export const WORKSPACE = "20000000-0000-4000-8000-000000000000";
export function environment() {
  let sequence = 0;
  let time = 100;
  return {
    now: () => time,
    id: () => `id-${++sequence}`,
    agentId: () => `30000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    advance: (delta: number) => {
      time += delta;
    },
  };
}
export function spec(overrides: Partial<ConductorSpec["policies"]> = {}): ConductorSpec {
  const model = { provider: "codex", model: "strong", tier: "normal", cost: 1, quota: 1 };
  return ConductorSpec.parse({
    rootAgentId: ROOT,
    workspaceId: WORKSPACE,
    goal: "Build the project",
    repositoryRules: "Read AGENTS.md. Test behaviour. No provider credentials.",
    constraints: {
      providers: ["codex", "claude"],
      models: ["strong", "fast", "adversary"],
      accounts: ["one", "two", "three"],
      budget: 200,
      maxParallel: 3,
      deadline: null,
      stallAfterMs: 1000,
    },
    policies: {
      planApproval: "auto",
      merge: "auto-after-verification",
      maxFixRounds: 2,
      roles: {
        planner: [model],
        worker: [{ ...model, model: "fast", tier: "fast" }],
        reviewer: [{ ...model, provider: "claude", model: "adversary" }, model],
        integrator: [model],
      },
      ...overrides,
    },
  });
}
export const accounts: Account[] = [
  { id: "one", provider: "codex", capacity: 3, externalActive: 0, quota: 100, resetAt: null },
  { id: "two", provider: "codex", capacity: 3, externalActive: 0, quota: 100, resetAt: null },
  { id: "three", provider: "claude", capacity: 3, externalActive: 0, quota: 100, resetAt: null },
];
export function plan(dependencies: Record<string, string[]> = { a: [] }): ConductorPlan {
  return ConductorPlan.parse({
    summary: "A bounded project",
    workstreams: Object.entries(dependencies).map(([id, deps]) => ({
      id,
      title: `Build ${id}`,
      dependencies: deps,
      priority: 0,
      brief: {
        objective: `Build ${id}`,
        instructions: "Implement and verify",
        acceptance: [`${id} works`],
        files: [`src/${id}.ts`],
        packages: [],
        risks: [],
      },
    })),
  });
}
export function review(id: string, verdict: "pass" | "changes_required" = "pass"): ConductorReview {
  return ConductorReview.parse({
    verdict,
    summary: verdict === "pass" ? "All checks pass" : "Fix behaviour",
    requirements: [
      { criterion: `${id} works`, passed: verdict === "pass", evidence: "Public API probe" },
    ],
    probes: ["Public edge probe"],
    mutations: Array.from({ length: 15 }, (_, i) => ({
      change: `Mutation ${i}`,
      caught: true,
      evidence: `Test ${i} failed`,
    })),
    flakiness: { runs: 3, passed: true, evidence: "Repeated checks" },
    design: { passed: true, evidence: "Ownership checked" },
    performance: { passed: true, evidence: "Measured work and memory" },
  });
}
export function completion(id = "a", revision = "a".repeat(40)) {
  return { branch: `work/${id}`, revision, summary: `Implemented ${id}` };
}
export class Harness {
  env = environment();
  state: State;
  effects: Effect[] = [];
  constructor(config = spec(), readyPlan = plan()) {
    const result = start("run", config, this.env);
    this.state = result.state;
    this.effects = result.effects;
    this.send({ type: "accounts", accounts });
    const planner = this.lane("planner");
    this.finish(planner, { kind: "plan", plan: readyPlan });
  }
  send(fact: unknown): Effect[] {
    const result = reduce(this.state, fact, this.env);
    this.state = result.state;
    this.effects = result.effects;
    return result.effects;
  }
  lane(role: Lane["role"], id: string | null = null): Lane {
    const lane = Object.values(this.state.lanes).find(
      (l) => l.live && l.role === role && (id === null || l.workstream === id),
    );
    if (!lane) throw new Error(`No active ${role} lane for ${id}`);
    return lane;
  }
  finish(lane: Lane, artifact: Artifact): void {
    this.send({ type: "artifact", laneId: lane.id, generation: lane.generation, artifact });
    this.send({
      type: "status",
      laneId: lane.id,
      generation: lane.generation,
      status: "done",
      at: this.env.now(),
    });
  }
  worker(id = "a", revision = "a".repeat(40)): void {
    this.finish(this.lane("worker", id), {
      kind: "completion",
      completion: completion(id, revision),
    });
  }
  reviewer(id = "a", verdict: "pass" | "changes_required" = "pass"): void {
    const revision = this.state.nodes[id]?.completion?.revision;
    if (!revision) throw new Error("Missing completion");
    this.finish(this.lane("reviewer", id), {
      kind: "review",
      review: review(id, verdict),
      revision,
    });
  }
}
export function mergeFact(effect: Effect, conflict: string | null = null) {
  if (effect.type !== "merge") throw new Error("Expected merge");
  return {
    type: "merge_result",
    operationId: effect.id,
    workstream: effect.workstream,
    revision: effect.completion.revision,
    conflict,
    trivial: true,
  };
}
export function verifyFact(effect: Effect, passed = true) {
  if (effect.type !== "verify") throw new Error("Expected verify");
  return {
    type: "verified",
    operationId: effect.id,
    workstream: effect.workstream,
    revision: effect.revision,
    passed,
    summary: "Verification result",
  };
}
export function effectOf(effects: Effect[], type: Effect["type"]): Effect {
  const effect = effects.find((e) => e.type === type);
  if (!effect) throw new Error(`Missing ${type} effect`);
  return effect;
}
