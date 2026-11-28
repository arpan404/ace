import { compactionBlocked } from "@ace/core";
import type { AgentStatus } from "@ace/protocol";

/*
 * Whether the provider can compact the root agent's context now, from its status. A provider
 * compacts its own idle context: its turn, or the person's question, comes first. Every client's
 * Compact reads this, so the web strip and the phone's sheet refuse with the same words.
 */

/** The root agent is compacting its context right now. */
export function contextCompacting(status: AgentStatus | undefined): boolean {
  return status?.state === "working" && status.activity === "compacting";
}

/** Why Compact can't be used now, or undefined when it can. */
export function compactRefusal(status: AgentStatus | undefined): string | undefined {
  if (contextCompacting(status)) return "Compacting now";
  return compactionBlocked(status) ? "Wait for this turn to finish" : undefined;
}
