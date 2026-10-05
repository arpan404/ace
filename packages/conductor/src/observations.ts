import { InteractionRequest, ThreadStatus } from "@ace/protocol";
import { z } from "zod";
import { Fact, Gate, Key } from "./schema.ts";

const Observation = z.object({
  laneId: Key,
  generation: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
  status: ThreadStatus,
});
/** Feed canonical whole-thread status from core/engine, never an individual turn's end.
 * Rate-limit waits are not assumed to be account exhaustion; the accounts boundary
 * supplies a separate confirmed usage_limit fact. */
export function threadObservation(input: unknown): Fact | null {
  const observation = Observation.parse(input);
  const state = observation.status.state;
  if (state === "new") return null;
  if (state === "limited")
    return Fact.parse({
      type: "usage_limit",
      laneId: observation.laneId,
      generation: observation.generation,
      at: observation.at,
    });
  return Fact.parse({
    type: "status",
    laneId: observation.laneId,
    generation: observation.generation,
    at: observation.at,
    status: state === "needs_you" || state === "waiting" ? "waiting" : state,
  });
}
/** The interaction port persists this request and a notification intent atomically. */
export function gateRequest(input: unknown): InteractionRequest {
  const gate = Gate.parse(input);
  return InteractionRequest.parse({
    kind: "approval",
    title: `Conductor ${gate.kind}`,
    description: gate.message,
    options: [
      { id: "approve", label: "Approve", kind: "allow_once" },
      { id: "reject", label: rejectLabel(gate), kind: "deny" },
    ],
  });
}
/** What rejecting does (approval.ts): a card's gate declines the card; budget, deadline and
 * any other gate not about a card stop the run. */
function rejectLabel(gate: Gate): string {
  if (gate.kind === "plan") return "Reject and draft a new plan";
  if (gate.kind === "budget" || gate.kind === "deadline" || !gate.workstream)
    return "Reject and cancel run";
  return "Decline this card";
}
