import { ConductorPlanOnInsensitiveFilesystem, type ConductorPlan } from "@ace/protocol";
import type { Artifact, Lane, Node, State } from "./schema.ts";
import { gate, release } from "./transition.ts";
import type { Context } from "./transition.ts";

export function installPlan(ctx: Context, plan: ConductorPlan): void {
  ctx.state.plan = admitOwnership(ctx.state, plan);
  ctx.state.nodes = Object.fromEntries(
    plan.workstreams.map((w) => [
      w.id,
      {
        id: w.id,
        state: "pending",
        lane: null,
        worker: null,
        fixRounds: 0,
        completion: null,
        reviews: [],
        lastReview: null,
        mergedRevision: null,
        conflict: null,
        trivialConflict: false,
        mergeApproved: false,
        operation: null,
      } satisfies Node,
    ]),
  );
}
export function settle(ctx: Context, lane: Lane): void {
  if (!lane.live || lane.status !== "done" || !lane.artifact) return;
  if (Object.values(ctx.state.gates).some((g) => g.kind === "escalation" && g.lane === lane.id))
    return;
  const node = lane.workstream ? ctx.state.nodes[lane.workstream] : null;
  if (ctx.state.phase === "cancelling") {
    release(ctx, lane);
    return;
  }
  if (lane.role === "planner" && lane.artifact.kind === "plan") {
    release(ctx, lane);
    delete ctx.state.lanes[lane.id];
    installPlan(ctx, lane.artifact.plan);
    if (ctx.state.spec.policies.planApproval === "required")
      gate(ctx, "plan", lane.artifact.plan.summary);
    else {
      ctx.state.planApproved = true;
      ctx.state.phase = ctx.state.phase === "paused" ? "paused" : "running";
      ctx.state.beforePause = "running";
    }
  } else if (node && node.lane === lane.id) {
    if (
      (lane.role === "worker" || lane.role === "integrator") &&
      lane.artifact.kind === "completion"
    ) {
      release(ctx, lane);
      node.completion = lane.artifact.completion;
      node.mergeApproved = false;
      node.state = "review_pending";
    } else if (lane.role === "reviewer" && lane.artifact.kind === "review") {
      validateReview(ctx.state, lane, lane.artifact);
      release(ctx, lane);
      delete ctx.state.lanes[lane.id];
      if (node.reviews.length >= 24) {
        node.state = "escalated";
        gate(ctx, "escalation", "Review retention limit reached; start a new run", node);
        return;
      }
      node.lastReview = lane.artifact.review;
      node.reviews = [
        ...node.reviews,
        {
          verdict: lane.artifact.review.verdict,
          summary: lane.artifact.review.summary.slice(0, 2048),
        },
      ];
      if (lane.artifact.review.verdict === "pass") node.state = "approved";
      else if (node.fixRounds < ctx.state.spec.policies.maxFixRounds) {
        node.fixRounds++;
        node.state = "fix_pending";
      } else {
        node.state = "escalated";
        gate(ctx, "escalation", lane.artifact.review.summary, node);
      }
    }
  }
}

export function validateReview(state: State, lane: Lane, artifact: Artifact): void {
  if (artifact.kind !== "review") return;
  const node = lane.workstream ? state.nodes[lane.workstream] : null;
  if (!node || artifact.revision !== node.completion?.revision)
    throw new Error("review_revision_mismatch");
  const criteria = state.plan?.workstreams.find((w) => w.id === node.id)?.brief.acceptance ?? [];
  const reviewed = artifact.review.requirements.map((r) => r.criterion);
  if (
    criteria.length !== reviewed.length ||
    new Set(reviewed).size !== criteria.length ||
    !criteria.every((c) => reviewed.includes(c))
  )
    throw new Error("review_requirements_mismatch");
}

export function admitOwnership(state: State, plan: ConductorPlan): ConductorPlan {
  return state.ownershipCase === "insensitive"
    ? ConductorPlanOnInsensitiveFilesystem.parse(plan)
    : plan;
}
