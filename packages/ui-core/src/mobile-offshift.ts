import type { ThreadReader } from "@ace/client";
import { isRunning } from "./agents.ts";
import { toneToken, type StatusToken } from "./mobile-status.ts";
import { offshiftSummary, type OffshiftSummary } from "./offshift.ts";

/*
 * A thread's Offshift run as the native apps show it: the web Summary's run (`offshiftSummary`)
 * worded against the whole agent tree, so it never reads Done while anything still works or
 * waits on the person, plus what the card says to do next and where the run ends. Pure.
 */

export interface MobileOffshift extends Omit<OffshiftSummary, "criteria"> {
  token: StatusToken;
  /** The run's next step as the card words it, when it says one. */
  next: string | null;
  /** What the run is for at its end ("Merged PR with green checks"). */
  endpoint: string;
  /** Required checks without a current pass, across every criterion. */
  pending: number;
  updatedAt: number;
  criteria: (Omit<OffshiftSummary["criteria"][number], "detail"> & {
    /** Each required kind's standing and who recorded it: "UI check · Passed · Codex". */
    evidence: string[];
  })[];
}

export function mobileOffshift(
  reader: Pick<
    ThreadReader,
    "offshift" | "thread" | "agentIds" | "agent" | "interactionIds" | "interaction"
  >,
): MobileOffshift | null {
  const card = reader.offshift;
  const thread = reader.thread;
  if (!card || !thread) return null;
  let runningAgents = 0;
  for (const id of reader.agentIds()) {
    const agent = reader.agent(id);
    if (agent && isRunning(agent)) runningAgents++;
  }
  let request: "approval" | "question" | undefined;
  for (const id of reader.interactionIds()) {
    const interaction = reader.interaction(id);
    if (interaction?.state !== "pending") continue;
    request = interaction.request.kind === "approval" ? "approval" : "question";
    break;
  }
  const summary = offshiftSummary(card, {
    status: thread.status,
    live: thread.live,
    runningAgents,
    request,
  });
  return {
    ...summary,
    token: toneToken(summary.tone),
    next: card.next ?? null,
    endpoint: card.endpoint,
    pending: card.pendingCount,
    updatedAt: card.updatedAt,
    criteria: summary.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      state: criterion.state,
      needs: criterion.needs,
      evidence: criterion.detail ? criterion.detail.split("\n") : [],
    })),
  };
}
