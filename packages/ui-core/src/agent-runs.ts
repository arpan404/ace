import type { Agent } from "@ace/protocol";
import { isRunning } from "./agents.ts";

/** What an agent's run identity reads. */
export type RunAgent = Pick<
  Agent,
  "id" | "origin" | "parentId" | "native" | "status" | "createdAt" | "spawnedBy"
>;

/**
 * Runs of one agent: a provider that resumes a settled subagent in a new session (after a daemon
 * restart, a coordinator's message to a stopped agent starts a fresh process) reports it as a new
 * agent under the same parent with the same native id. Each such identity is one agent whose
 * latest run is its state; the earlier runs are its history.
 */
export interface AgentRuns {
  /** An earlier, settled run's id → the id of the identity's latest run. */
  latest: ReadonlyMap<string, string>;
  /** The latest run's id → its earlier runs, oldest first. */
  earlier: ReadonlyMap<string, readonly RunAgent[]>;
}

const none: AgentRuns = { latest: new Map(), earlier: new Map() };

function identities(agent: RunAgent): string[] {
  if (agent.origin === "root") return [];
  const ids = [agent.native.nativeId, ...(agent.native.aliases ?? [])].filter(
    (id): id is string => !!id,
  );
  return ids.map((id) => `${agent.parentId ?? ""}\u0000${agent.native.provider}\u0000${id}`);
}

/**
 * Group the agents of one thread into runs of the same identity. An earlier run only yields to a
 * later one once it has settled: two runs both still going are both shown, so nothing working is
 * ever hidden. Pure; linear in the number of agents.
 */
export function agentRuns(agents: readonly RunAgent[]): AgentRuns {
  const groups = new Map<string, RunAgent[]>();
  const owner = new Map<string, RunAgent[]>();
  for (const agent of agents) {
    const keys = identities(agent);
    // An agent joins the first group any of its native ids already names.
    let group = keys.map((key) => groups.get(key)).find((found) => found !== undefined);
    if (!group) group = [];
    group.push(agent);
    for (const key of keys) if (!groups.has(key)) groups.set(key, group);
    owner.set(agent.id, group);
  }
  let latest: Map<string, string> | undefined;
  let earlier: Map<string, RunAgent[]> | undefined;
  for (const group of new Set(owner.values())) {
    if (group.length < 2) continue;
    const ordered = group.toSorted((left, right) => left.createdAt - right.createdAt);
    const last = ordered.at(-1);
    if (!last) continue;
    const settled = ordered.slice(0, -1).filter((run) => !isRunning(run));
    if (!settled.length) continue;
    latest ??= new Map();
    earlier ??= new Map();
    for (const run of settled) latest.set(run.id, last.id);
    earlier.set(last.id, settled);
  }
  return latest && earlier ? { latest, earlier } : none;
}

/** The agents whose latest run they are: every agent but the superseded runs. */
export function latestRuns<T extends RunAgent>(agents: readonly T[], runs = agentRuns(agents)) {
  return runs.latest.size ? agents.filter((agent) => !runs.latest.has(agent.id)) : agents;
}

/** An earlier run that ended because the daemon restarted under it. */
export const endedByRestart = (run: Pick<Agent, "status">) =>
  run.status.state === "failed" && run.status.error.kind === "process_exit";
