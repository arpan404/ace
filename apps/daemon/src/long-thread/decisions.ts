import type { AgentOrigin, AgentStatus, ThreadStatus } from "@ace/protocol";
import { agentThreadStatus, turnIsSettled } from "@ace/projection";

/** Ownership decisions depend only on durable facts read by the writer's I/O shell. */
export function itemTurnOrdinal(facts: {
  existingOrdinal: number | undefined;
  runOrdinal: number | undefined;
  fallbackOrdinal: number;
  rootUserMessage: boolean;
  headOrdinal: number;
  currentTurn: { hasRootRun: boolean; hasInitiatingPreview: boolean } | undefined;
}): number {
  if (facts.existingOrdinal !== undefined) return facts.existingOrdinal;
  if (facts.runOrdinal !== undefined) return facts.runOrdinal;
  if (
    facts.rootUserMessage &&
    (!facts.currentTurn || facts.currentTurn.hasRootRun || facts.currentTurn.hasInitiatingPreview)
  )
    return facts.headOrdinal + 1;
  return facts.fallbackOrdinal;
}

export function createdAgentTurnOrdinal(facts: {
  origin: AgentOrigin;
  headOrdinal: number;
  spawnedByOrdinal: number | undefined;
  parentOrdinal: number | undefined;
  currentOrdinal: number;
}): number {
  return facts.origin === "root"
    ? facts.headOrdinal
    : (facts.spawnedByOrdinal ?? facts.parentOrdinal ?? facts.currentOrdinal);
}

export function startedRunTurnOrdinal(facts: {
  root: boolean;
  providerOrdinal: number | undefined;
  knownOrdinal: number | undefined;
  headOrdinal: number;
  agentOrdinal: number;
}): number {
  return facts.root
    ? (facts.providerOrdinal ?? facts.knownOrdinal ?? facts.headOrdinal + 1)
    : facts.agentOrdinal;
}

export function agentActivityCounters(facts: {
  root: boolean;
  status: AgentStatus;
  linkedChildStatus: ThreadStatus | undefined;
}): Record<string, number> {
  const ownSettled = turnIsSettled(agentThreadStatus(facts.status));
  const childLive =
    facts.linkedChildStatus !== undefined && !turnIsSettled(facts.linkedChildStatus);
  return {
    "live:agents": Number(!ownSettled || childLive),
    subagentsStarted: Number(!facts.root),
    subagentsFinished: Number(!facts.root && ownSettled && !childLive),
  };
}

/** A root's pre-run working status must not reopen its previously completed turn. */
export function agentActivityTransition(facts: {
  root: boolean;
  ordinal: number;
  previousOrdinal: number | undefined;
  turnSettled: boolean;
  status: AgentStatus;
  previousStatus: AgentStatus | undefined;
}): { recordActivity: boolean; recordError: boolean } {
  const historicalRoot =
    facts.root &&
    facts.previousOrdinal === facts.ordinal &&
    facts.turnSettled &&
    !turnIsSettled(agentThreadStatus(facts.status));
  const recordActivity = facts.ordinal > 0 && !historicalRoot;
  return {
    recordActivity,
    recordError:
      recordActivity && facts.status.state === "failed" && facts.previousStatus?.state !== "failed",
  };
}

/** Liveness wins over the root outcome; a late original-turn fact can reopen it. */
export function turnSettlementTransition(facts: {
  rootOutcome: string;
  alreadySettled: boolean;
  ordinal: number;
  currentOrdinal: number;
  currentStatus: ThreadStatus;
  linkedChildLive: boolean;
  counters: Readonly<Record<string, number>>;
}): "settle" | "reopen" | "keep" {
  const live =
    facts.linkedChildLive ||
    Object.entries(facts.counters).some(([key, value]) => key.startsWith("live:") && value > 0);
  const settled =
    facts.rootOutcome !== "active" &&
    !live &&
    (facts.ordinal !== facts.currentOrdinal || turnIsSettled(facts.currentStatus));
  if (settled && !facts.alreadySettled) return "settle";
  if (!settled && facts.alreadySettled && live) return "reopen";
  return "keep";
}
