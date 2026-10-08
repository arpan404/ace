import type { ConductorRunView, ProviderKind } from "@ace/protocol";
import type { DeckAgent, DeckAgentRole, LaneRole } from "./deck.ts";
import { providerNames } from "./providers.ts";

/*
 * A deck's delegated threads (`ConductorRunView.delegations`) as agents: who each one is, on
 * which account, and when its thread started and last changed. Delegations outlive their lanes,
 * so a card keeps its worker and reviewer after both retire.
 */

type View = ConductorRunView;
type Delegation = View["delegations"][number];

/** What the daemon's account list says about an account. */
export interface DeckAccount {
  label: string;
  provider: ProviderKind;
}
export type DeckAccounts = (id: string) => DeckAccount | undefined;

/** What this client knows about a delegated thread (the live thread list). */
export interface DeckThread {
  title: string;
  createdAt: number;
  updatedAt: number;
}
export type DeckThreads = (threadId: string) => DeckThread | undefined;

const isProvider = (value: string): value is ProviderKind => Object.hasOwn(providerNames, value);

/**
 * An account as a person reads it: its label from the account list; `local.<provider>` is the
 * installed CLI's own login. Never a raw id: an account the daemon no longer lists is "removed".
 */
export function deckAccount(id: string, accounts: DeckAccounts): DeckAccount | undefined {
  const known = accounts(id);
  if (known) return known;
  const local = /^local\.(\w+)$/.exec(id)?.[1];
  return local && isProvider(local)
    ? { label: `${providerNames[local]} · default login`, provider: local }
    : undefined;
}

export function laneRole(account: string, model: string, accounts: DeckAccounts): LaneRole {
  const known = deckAccount(account, accounts);
  return {
    account: known?.label ?? "Account removed",
    provider: known?.provider,
    detail: model,
  };
}

/**
 * The daemon titles each lane's thread "Offset worker: health" ("Deck worker: health" before the
 * rename); retired lanes are known by it.
 */
const titled = /^(?:Offset|Deck) (planner|worker|reviewer|integrator):/;

function roleOf(
  delegation: Delegation,
  nested: boolean,
  lanes: View["lanes"],
  thread: DeckThread | undefined,
): DeckAgentRole | null {
  if (nested) return "subagent";
  const lane = lanes.find((entry) => entry.id === delegation.laneId);
  if (lane) return lane.role;
  const role = thread && titled.exec(thread.title)?.[1];
  if (role === "planner" || role === "worker" || role === "reviewer" || role === "integrator")
    return role;
  return delegation.workstream === null ? "planner" : null;
}

const roleLabels: Record<DeckAgentRole, string> = {
  planner: "Planner",
  worker: "Worker",
  reviewer: "Reviewer",
  integrator: "Fix",
  subagent: "Sub-agent",
};

function agentOf(
  delegation: Delegation,
  nested: boolean,
  view: View,
  accounts: DeckAccounts,
  threads: DeckThreads,
): DeckAgent {
  const thread = threads(delegation.threadId);
  const role = roleOf(delegation, nested, view.lanes, thread);
  const account = delegation.account ?? `local.${delegation.provider}`;
  const known = deckAccount(account, accounts);
  const round = delegation.generation > 0 ? `, round ${delegation.generation + 1}` : "";
  return {
    threadId: delegation.threadId,
    agentId: delegation.agentId,
    role,
    label: role ? `${roleLabels[role]}${role === "subagent" ? "" : round}` : "Agent",
    account: known?.label ?? "Account removed",
    provider:
      known?.provider ?? (isProvider(delegation.provider) ? delegation.provider : undefined),
    generation: delegation.generation,
    live: delegation.phase !== "settled",
    nested,
    startedAt: thread?.createdAt,
    updatedAt: thread?.updatedAt,
  };
}

/**
 * Every agent of a deck, by card (`null` for the planner and its children): live ones first,
 * then the newest generation, so a card's current worker leads its list.
 */
export function deckAgents(
  view: View,
  accounts: DeckAccounts,
  threads: DeckThreads,
): Map<string | null, DeckAgent[]> {
  const own = new Set(view.delegations.map((delegation) => delegation.threadId));
  const byCard = new Map<string | null, DeckAgent[]>();
  for (const delegation of view.delegations) {
    const agent = agentOf(delegation, own.has(delegation.parentThreadId), view, accounts, threads);
    const list = byCard.get(delegation.workstream) ?? [];
    list.push(agent);
    byCard.set(delegation.workstream, list);
  }
  for (const list of byCard.values())
    list.sort(
      (a, b) =>
        Number(b.live) - Number(a.live) ||
        Number(a.nested) - Number(b.nested) ||
        b.generation - a.generation ||
        (b.startedAt ?? 0) - (a.startedAt ?? 0),
    );
  return byCard;
}

/** The first agent thread to start and the latest to change, when this client has any. */
export function agentTimes(agents: readonly DeckAgent[]): {
  startedAt: number | undefined;
  updatedAt: number | undefined;
} {
  let startedAt: number | undefined;
  let updatedAt: number | undefined;
  for (const agent of agents) {
    if (agent.startedAt !== undefined)
      startedAt = startedAt === undefined ? agent.startedAt : Math.min(startedAt, agent.startedAt);
    if (agent.updatedAt !== undefined)
      updatedAt = updatedAt === undefined ? agent.updatedAt : Math.max(updatedAt, agent.updatedAt);
  }
  return { startedAt, updatedAt };
}
