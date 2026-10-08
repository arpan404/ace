import type { ConductorSpec } from "@ace/protocol";
import { plannerPrompt, reviewerPrompt, workerBrief } from "./prompts.ts";
import { selectAccount } from "./scheduler.ts";
import type { Assignment } from "./scheduler.ts";
import type { Effect, Environment, Gate, Lane, Node, Role, State } from "./schema.ts";

export interface Context {
  state: State;
  effects: Effect[];
  env: Environment;
}
export function gate(
  ctx: Context,
  kind: Gate["kind"],
  message: string,
  node: Node | null = null,
  lane: Lane | null = null,
): void {
  if (
    Object.values(ctx.state.gates).some(
      (g) =>
        g.kind === kind && g.workstream === (node?.id ?? null) && g.lane === (lane?.id ?? null),
    )
  )
    return;
  if (Object.keys(ctx.state.gates).length >= 512) throw new Error("gate_backpressure");
  const item: Gate = {
    id: ctx.env.id(),
    kind,
    gatedAt: ctx.env.now(),
    message: message.slice(0, 16_384),
    workstream: node?.id ?? null,
    lane: lane?.id ?? null,
    generation: lane?.generation ?? null,
  };
  ctx.state.gates[item.id] = item;
  ctx.effects.push({
    type: "gate",
    id: ctx.env.id(),
    gate: item,
    rootAgentId: ctx.state.spec.rootAgentId,
  });
}
export function closeGate(ctx: Context, id: string): void {
  const closed = ctx.state.gates[id];
  delete ctx.state.gates[id];
  // Starts held at a human gate receive their admission window when it opens.
  if (closed)
    for (const lane of Object.values(ctx.state.lanes)) {
      if (
        lane.live &&
        lane.status === "starting" &&
        (["plan", "budget", "deadline"].includes(closed.kind) ||
          closed.lane === lane.id ||
          (closed.workstream !== null && closed.workstream === lane.workstream))
      )
        lane.lastActivity = ctx.env.now();
    }
  ctx.effects.push({ type: "gate_closed", id: ctx.env.id(), gateId: id });
}
export function control(
  ctx: Context,
  lane: Lane,
  action: "pause" | "resume" | "cancel" | "force_cancel" | "allow_destructive",
): void {
  ctx.effects.push({ type: "control", id: ctx.env.id(), lane: { ...lane }, action });
}
export function canSpend(ctx: Context, cost: number): boolean {
  if (ctx.state.spent + cost <= ctx.state.spec.constraints.budget) return true;
  gate(
    ctx,
    "budget",
    `Reserved cost ${ctx.state.spent + cost} exceeds budget ${ctx.state.spec.constraints.budget}`,
  );
  return false;
}
export function assign(ctx: Context, role: Role, previous: Lane | null = null): Assignment | null {
  return selectAccount(
    ctx.state.spec,
    ctx.state.accounts,
    Object.values(ctx.state.lanes),
    role,
    previous,
  );
}
export function launch(
  ctx: Context,
  role: Role,
  node: Node | null,
  source: Lane | null = null,
): Lane | null {
  // Bounded lifetime lane history. Source sessions stay addressable for forks.
  if (Object.keys(ctx.state.lanes).length >= 8192) {
    gate(ctx, "escalation", "Run lane retention limit reached; start a new run", node);
    return null;
  }
  const choice = assign(
    ctx,
    role,
    role === "reviewer" && node?.worker ? (ctx.state.lanes[node.worker] ?? null) : null,
  );
  if (!choice || !canSpend(ctx, choice.model.cost)) return null;
  const lane: Lane = {
    id: ctx.env.id(),
    agentId: ctx.env.agentId(),
    role,
    workstream: node?.id ?? null,
    generation: 0,
    account: choice.account.id,
    model: choice.model,
    status: "starting",
    lastActivity: ctx.env.now(),
    migrationObservation: null,
    artifactDeadline: null,
    artifact: null,
    correctionPending: false,
    artifactRetries: 0,
    rejectedArtifact: null,
    source: source?.id ?? null,
    live: true,
    retiring: false,
    stopRequestedAt: null,
  };
  const brief = ctx.state.plan?.workstreams.find((w) => w.id === node?.id)?.brief;
  let prompt = plannerPrompt(ctx.state.spec, ctx.state.rejectedPlan);
  if (brief && role === "reviewer" && node?.completion)
    prompt = reviewerPrompt(brief, node.completion.revision, ctx.state.spec.repositoryRules);
  else if (brief)
    prompt =
      workerBrief(
        ctx.state.spec.goal,
        brief,
        ctx.state.spec.repositoryRules,
        node?.lastReview ?? null,
      ) + (node?.conflict ? `\nResolve merge conflict: ${JSON.stringify(node.conflict)}` : "");
  ctx.state.spent += choice.model.cost;
  if (source && !source.live) delete ctx.state.lanes[source.id];
  ctx.state.lanes[lane.id] = lane;
  ctx.effects.push({
    type: "launch",
    id: ctx.env.id(),
    lane: { ...lane },
    prompt,
    rootAgentId: ctx.state.spec.rootAgentId,
    workspaceId: ctx.state.spec.workspaceId,
    completion: node?.completion ?? null,
    conflict: node?.conflict ?? null,
    dependencies: (
      ctx.state.plan?.workstreams.find((w) => w.id === node?.id)?.dependencies ?? []
    ).map((id) => {
      const completion = ctx.state.nodes[id]?.completion;
      if (!completion) throw new Error("dependency_completion_missing");
      return completion;
    }),
  });
  if (node) {
    node.lane = lane.id;
    node.state = role === "reviewer" ? "reviewing" : "working";
    if (role !== "reviewer") node.worker = lane.id;
  } else ctx.state.planner = lane.id;
  return lane;
}
export function emptyState(
  id: string,
  spec: ConductorSpec,
  ownershipCase: State["ownershipCase"],
  at = 0,
): State {
  return {
    version: 1,
    startedAt: at,
    updatedAt: at,
    id,
    spec,
    phase: "planning",
    beforePause: "planning",
    plan: null,
    planApproved: false,
    rejectedPlan: null,
    ownershipCase,
    accounts: [],
    lanes: {},
    nodes: {},
    gates: {},
    spent: 0,
    integration: null,
    planner: null,
  };
}

export function release(ctx: Context, lane: Lane): void {
  if (!lane.live) return;
  lane.live = false;
  if (lane.retiring && (lane.role === "reviewer" || lane.role === "planner"))
    delete ctx.state.lanes[lane.id];
  const account = ctx.state.accounts.find((a) => a.id === lane.account);
  if (account) account.quota = Math.max(0, account.quota - lane.model.quota);
}

/** Terminal observations already prove settlement; no second observer event is required. */
export function retire(ctx: Context, lane: Lane): void {
  if (!lane.live) {
    if (lane.role === "reviewer" || lane.role === "planner") delete ctx.state.lanes[lane.id];
    return;
  }
  if (lane.retiring) return;
  lane.retiring = true;
  lane.stopRequestedAt = ctx.env.now();
  control(ctx, lane, "cancel");
  if (lane.status === "done" || lane.status === "failed") release(ctx, lane);
}
