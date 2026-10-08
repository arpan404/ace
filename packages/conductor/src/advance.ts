import { heldWorkstreams, readyWorkstreams, selectAccount } from "./scheduler.ts";
import type { Context } from "./transition.ts";
import { assign, canSpend, control, gate, launch, retire } from "./transition.ts";

export function advance(ctx: Context): void {
  const s = ctx.state;
  if (s.phase === "cancelling") {
    if (Object.values(s.lanes).every((l) => !l.live) && !s.integration) s.phase = "cancelled";
    return;
  }
  if (s.phase === "paused" || s.phase === "cancelled" || s.phase === "done") return;
  if (s.spec.constraints.deadline !== null && ctx.env.now() >= s.spec.constraints.deadline)
    gate(ctx, "deadline", "Project deadline reached");
  if (Object.values(s.gates).some((g) => ["budget", "deadline", "plan"].includes(g.kind))) return;
  for (const lane of Object.values(s.lanes)) {
    if (
      !lane.live ||
      lane.retiring ||
      Object.values(s.gates).some(
        (g) => g.lane === lane.id || (g.workstream !== null && g.workstream === lane.workstream),
      )
    )
      continue;
    if (lane.status === "limited") {
      const same = selectAccount(
        {
          ...s.spec,
          policies: {
            ...s.spec.policies,
            roles: { ...s.spec.policies.roles, [lane.role]: [lane.model] },
          },
        },
        s.accounts.filter((a) => a.id === lane.account),
        Object.values(s.lanes),
        lane.role,
      );
      if (same) {
        lane.status = "working";
        lane.lastActivity = ctx.env.now();
        control(ctx, lane, "resume");
        continue;
      }
      const choice = assign(ctx, lane.role, lane);
      if (!choice || !canSpend(ctx, choice.model.cost)) continue;
      const fromAccount = lane.account;
      lane.account = choice.account.id;
      lane.model = choice.model;
      lane.generation++;
      lane.status = "migrating";
      lane.migrationObservation = null;
      lane.artifactDeadline = null;
      lane.artifact = null;
      lane.lastActivity = ctx.env.now();
      s.spent += choice.model.cost;
      ctx.effects.push({ type: "migrate", id: ctx.env.id(), lane: { ...lane }, fromAccount });
    }
  }
  if (s.phase === "planning") {
    if (!s.planner && !Object.values(s.lanes).some((l) => l.role === "planner" && l.live))
      launch(ctx, "planner", null);
    return;
  }
  if (!s.planApproved || !s.plan) return;
  const blocked = new Set(Object.values(s.gates).map((g) => g.workstream));
  for (const w of s.plan.workstreams) {
    const node = s.nodes[w.id];
    if (!node || blocked.has(w.id)) continue;
    const current = node.lane ? s.lanes[node.lane] : null;
    if (current?.live && current.retiring) continue;
    const source = node.worker ? (s.lanes[node.worker] ?? null) : null;
    if (node.state === "review_pending") launch(ctx, "reviewer", node);
    else if ((node.state === "fix_pending" || node.state === "conflict_pending") && !source?.live)
      launch(
        ctx,
        node.state === "conflict_pending" && node.trivialConflict ? "integrator" : "worker",
        node,
        source,
      );
  }
  for (const id of readyWorkstreams(s)) {
    const node = s.nodes[id];
    if (node && !blocked.has(id) && !launch(ctx, "worker", node)) break;
  }
  if (!s.integration) {
    for (const w of s.plan.workstreams) {
      const node = s.nodes[w.id];
      if (!node || node.state !== "approved" || !node.completion || blocked.has(w.id)) continue;
      if (s.spec.policies.merge === "ask" && !node.mergeApproved) {
        gate(ctx, "merge", `Merge ${node.completion.branch} at ${node.completion.revision}`, node);
        continue;
      }
      node.state = "merging";
      s.integration = node.id;
      node.operation = ctx.env.id();
      node.integrationKey = node.operation;
      ctx.effects.push({
        type: "merge",
        id: node.operation,
        workstream: node.id,
        completion: node.completion,
        mode: s.spec.policies.merge === "PR-only" ? "pr" : "local",
      });
      break;
    }
  }
  const held = heldWorkstreams(s);
  if (
    Object.values(s.nodes).every((n) => n.state === "integrated" || held.has(n.id)) &&
    Object.values(s.lanes).every((l) => !l.live) &&
    Object.keys(s.gates).length === 0 &&
    !s.integration
  )
    s.phase = "done";
}

export function cancel(ctx: Context): void {
  if (ctx.state.phase === "cancelling" || ctx.state.phase === "cancelled") return;
  ctx.state.phase = "cancelling";
  for (const lane of Object.values(ctx.state.lanes)) {
    retire(ctx, lane);
  }
}
