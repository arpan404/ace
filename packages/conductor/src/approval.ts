import type { z } from "zod";
import type { ConductorApproval } from "@ace/protocol";
import { cancel } from "./advance.ts";
import { installPlan } from "./completion.ts";
import { closeGate, control, retire } from "./transition.ts";
import type { Context } from "./transition.ts";
import type { Gate } from "./schema.ts";

export function approve(ctx: Context, approval: z.infer<typeof ConductorApproval>): void {
  const s = ctx.state;
  const g = s.gates[approval.gateId];
  if (!Object.hasOwn(s.gates, approval.gateId) || !g) throw new Error("gate_not_pending");
  if (approval.decision === "reject") {
    reject(ctx, g, approval.feedback);
    return;
  }
  const node = g.workstream ? s.nodes[g.workstream] : null;
  const lane = g.lane ? s.lanes[g.lane] : null;
  switch (g.kind) {
    case "plan":
      if (approval.plan) installPlan(ctx, approval.plan);
      if (!s.plan) throw new Error("plan_missing");
      s.planApproved = true;
      s.rejectedPlan = null;
      s.beforePause = "running";
      if (s.phase !== "paused") s.phase = "running";
      break;
    case "merge":
      if (!node || node.state !== "approved") throw new Error("merge_not_ready");
      node.mergeApproved = true;
      break;
    case "budget":
      if (approval.budget === undefined || approval.budget <= s.spec.constraints.budget)
        throw new Error("budget_must_increase");
      s.spec = { ...s.spec, constraints: { ...s.spec.constraints, budget: approval.budget } };
      break;
    case "deadline":
      if (approval.deadline === undefined || approval.deadline <= ctx.env.now())
        throw new Error("deadline_must_be_future");
      s.spec = { ...s.spec, constraints: { ...s.spec.constraints, deadline: approval.deadline } };
      break;
    case "destructive":
      if (!lane || !lane.live || lane.generation !== g.generation) throw new Error("lane_not_live");
      control(ctx, lane, "allow_destructive");
      break;
    case "escalation":
      if (node && (node.reviews.length >= 24 || Object.keys(s.lanes).length >= 8192))
        throw new Error("run_retention_limit");
      if (lane?.live) retire(ctx, lane);
      if (lane && !lane.live && (lane.role === "planner" || lane.role === "reviewer"))
        delete s.lanes[lane.id];
      if (lane?.role === "planner") s.planner = null;
      else if (node) {
        if (lane?.role === "reviewer") node.state = "review_pending";
        else node.state = node.conflict ? "conflict_pending" : "fix_pending";
      }
      break;
  }
  closeGate(ctx, g.id);
}

/**
 * Rejection answers the gate's own question; it never bypasses it (ADR 0017):
 * - plan: the drafted plan is dropped and the planner drafts another, told which one was rejected;
 * - merge, escalation and destructive gates on a card decline that card: its live lanes stop, it
 *   never merges and the cards that depend on it never start, while the rest of the deck carries
 *   on. The deck finishes once nothing else can move;
 * - budget, deadline, and any gate not about a card: the deck stops, as `conductor.cancel` does.
 */
function reject(ctx: Context, g: Gate, feedback?: string): void {
  const s = ctx.state;
  const node = g.workstream ? (s.nodes[g.workstream] ?? null) : null;
  if (g.kind === "plan") {
    closeGate(ctx, g.id);
    s.rejectedPlan =
      [s.plan?.summary, feedback ? `User feedback: ${feedback}` : null]
        .filter(Boolean)
        .join("\n")
        .slice(0, 16_384) || null;
    s.plan = null;
    s.nodes = {};
    s.planApproved = false;
    s.planner = null;
    return;
  }
  if (g.kind === "budget" || g.kind === "deadline" || !node) {
    for (const id of Object.keys(s.gates)) closeGate(ctx, id);
    cancel(ctx);
    return;
  }
  for (const other of Object.values(s.gates))
    if (other.id === g.id || other.workstream === node.id) closeGate(ctx, other.id);
  for (const lane of Object.values(s.lanes)) {
    if (lane.retiring || lane.workstream !== node.id) continue;
    retire(ctx, lane);
  }
  node.state = "declined";
  node.mergeApproved = false;
}
