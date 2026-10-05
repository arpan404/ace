import type { ConductorModel, ConductorSpec } from "@ace/protocol";
import type { Account, Lane, Role, State } from "./schema.ts";

export interface Assignment {
  account: Account;
  model: ConductorModel;
}
export function selectAccount(
  spec: ConductorSpec,
  accounts: readonly Account[],
  lanes: readonly Lane[],
  role: Role,
  previous: Lane | null = null,
): Assignment | null {
  const usage = new Map<string, { active: number; quota: number }>();
  let active = 0;
  for (const lane of lanes) {
    if (!lane.live || lane.status === "limited") continue;
    active++;
    const used = usage.get(lane.account) ?? { active: 0, quota: 0 };
    used.active++;
    used.quota += lane.model.quota;
    usage.set(lane.account, used);
  }
  if (active >= spec.constraints.maxParallel) return null;
  const candidates: Assignment[] = [];
  for (const model of spec.policies.roles[role]) {
    if (
      !spec.constraints.providers.includes(model.provider) ||
      !spec.constraints.models.includes(model.model)
    )
      continue;
    for (const account of accounts) {
      if (!spec.constraints.accounts.includes(account.id) || account.provider !== model.provider)
        continue;
      if (previous?.status === "limited" && account.id === previous.account) continue;
      const used = usage.get(account.id) ?? { active: 0, quota: 0 };
      if (
        account.externalActive + used.active >= account.capacity ||
        account.quota - used.quota < model.quota
      )
        continue;
      candidates.push({ account, model });
    }
  }
  const worker =
    role === "reviewer" && previous?.role === "reviewer"
      ? (lanes.find(
          (l) =>
            l.workstream === previous.workstream &&
            (l.role === "worker" || l.role === "integrator"),
        ) ?? previous)
      : previous;
  if (role === "reviewer" && worker) {
    const score = (c: Assignment) =>
      c.model.provider !== worker.model.provider ? 2 : c.model.model !== worker.model.model ? 1 : 0;
    candidates.sort((a, b) => {
      return score(b) - score(a);
    });
  }
  return candidates[0] ?? null;
}

/** Only verified integrations satisfy dependencies. Stable ties follow plan order. */
export function readyWorkstreams(state: State): string[] {
  return (state.plan?.workstreams ?? [])
    .filter(
      (w) =>
        state.nodes[w.id]?.state === "pending" &&
        w.dependencies.every((d) => state.nodes[d]?.state === "integrated"),
    )
    .toSorted((a, b) => b.priority - a.priority)
    .map((w) => w.id);
}

/**
 * Declined workstreams and every pending one that depends on one, directly or not: none of them
 * can ever run, so a deck whose other work is integrated is finished.
 */
export function heldWorkstreams(state: State): Set<string> {
  const held = new Set<string>();
  for (const node of Object.values(state.nodes)) if (node.state === "declined") held.add(node.id);
  if (!held.size) return held;
  const workstreams = state.plan?.workstreams ?? [];
  // Plans are acyclic and at most 256 workstreams; repeat until no dependant is added.
  for (let changed = true; changed;) {
    changed = false;
    for (const w of workstreams)
      if (
        !held.has(w.id) &&
        state.nodes[w.id]?.state === "pending" &&
        w.dependencies.some((d) => held.has(d))
      ) {
        held.add(w.id);
        changed = true;
      }
  }
  return held;
}
