import type { State } from "./schema.ts";

export function progress(state: State) {
  const lanes = Object.values(state.lanes);
  const active = lanes.filter((l) => l.live);
  return {
    id: state.id,
    plan: state.plan,
    phase: state.phase,
    spent: state.spent,
    budget: state.spec.constraints.budget,
    needsUser: Object.values(state.gates),
    dag: (state.plan?.workstreams ?? []).map((w) => ({
      id: w.id,
      title: w.title,
      dependencies: w.dependencies,
      state: state.nodes[w.id]?.state,
      fixRounds: state.nodes[w.id]?.fixRounds,
      reviews: state.nodes[w.id]?.reviews.map((r) => ({ verdict: r.verdict, summary: r.summary })),
      revision: state.nodes[w.id]?.mergedRevision,
      integrationMode:
        state.spec.policies.merge === "PR-only"
          ? "PR with verified CI"
          : "local merge with verified checks",
    })),
    lanes: active.map((l) => ({
      id: l.id,
      parentId: state.spec.rootAgentId,
      agentId: l.agentId,
      role: l.role,
      workstream: l.workstream,
      account: l.account,
      model: l.model.model,
      tier: l.model.tier,
      generation: l.generation,
      status: l.status,
    })),
    accounts: state.accounts.map((a) => ({
      ...a,
      reservedQuota: active
        .filter((l) => l.account === a.id && l.status !== "limited")
        .reduce((total, l) => total + l.model.quota, 0),
      active: active.filter((l) => l.account === a.id && l.status !== "limited").length,
    })),
  };
}
