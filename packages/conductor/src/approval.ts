import type { z } from "zod";
import type { ConductorApproval } from "@ace/protocol";
import { cancel } from "./advance.ts";
import { installPlan } from "./completion.ts";
import { closeGate, control } from "./transition.ts";
import type { Context } from "./transition.ts";

export function approve(ctx: Context, approval: z.infer<typeof ConductorApproval>): void {
  const s = ctx.state;
  const g = s.gates[approval.gateId];
  if (!Object.hasOwn(s.gates, approval.gateId) || !g) throw new Error("gate_not_pending");
  if (approval.decision === "reject") {
    for (const id of Object.keys(s.gates)) closeGate(ctx, id);
    cancel(ctx);
    return;
  }
  const node = g.workstream ? s.nodes[g.workstream] : null;
  const lane = g.lane ? s.lanes[g.lane] : null;
  switch (g.kind) {
    case "plan":
      if (approval.plan) installPlan(ctx, approval.plan);
      if (!s.plan) throw new Error("plan_missing");
      s.planApproved = true;
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
      if (lane?.live) {
        lane.retiring = true;
        control(ctx, lane, "cancel");
      }
      if (lane && !lane.live && (lane.role === "planner" || lane.role === "reviewer"))
        delete s.lanes[lane.id];
      if (lane?.role === "planner") s.planner = null;
      else if (node) {
        if (lane?.role === "reviewer") node.state = "review_pending";
        else node.state = "fix_pending";
      }
      break;
  }
  closeGate(ctx, g.id);
}
