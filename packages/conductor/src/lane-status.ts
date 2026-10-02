import type { Lane } from "./schema.ts";
import type { Context } from "./transition.ts";
import { gate, release } from "./transition.ts";
import { settle } from "./completion.ts";

export function applyLaneStatus(ctx: Context, lane: Lane): void {
  if (lane.status === "done" && !lane.artifact && !lane.retiring)
    lane.artifactDeadline ??= lane.lastActivity + ctx.state.spec.constraints.stallAfterMs;
  else if (lane.status !== "done") lane.artifactDeadline = null;
  const node = lane.workstream ? (ctx.state.nodes[lane.workstream] ?? null) : null;
  if (lane.retiring && (lane.status === "done" || lane.status === "failed")) release(ctx, lane);
  else if (lane.status === "failed" || lane.status === "unresponsive") {
    if (lane.status === "failed") release(ctx, lane);
    if (node) node.state = "escalated";
    gate(ctx, "escalation", `Lane ${lane.id} is ${lane.status}`, node, lane);
  } else settle(ctx, lane);
}
