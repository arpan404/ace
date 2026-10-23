import type { MessageArrival } from "@ace/protocol";
import type { MessageFacts } from "../engine/message-facts.ts";

/** How an agent's message reaches its thread, or why it never will. */
export type ArrivalReading = { ok: true; arrival: MessageArrival } | { ok: false; hint: string };

const resend = "Send it again with a new requestId if it still applies.";

/**
 * Maps what the engine knows about an accepted message to what the sender is told. A message
 * that will never run (failed, removed, replaced) is refused, never reported as on its way.
 * `restart` is read right after its interrupt: the stopped turn is ending, so the message starts
 * the next one unless the thread's queue is held.
 */
export function messageArrival(facts: MessageFacts, restart = false): ArrivalReading {
  switch (facts.fate) {
    case "failed":
      return {
        ok: false,
        hint: `That message failed and won't be sent: ${facts.error}. ${resend}`,
      };
    case "removed":
      return { ok: false, hint: `That message was removed from the thread's queue. ${resend}` };
    case "replaced":
      return { ok: false, hint: `That message was replaced by a newer one. ${resend}` };
    case "unknown":
      return { ok: false, hint: `ace has no record of that message. ${resend}` };
    case "delivered":
      return { ok: true, arrival: "delivered" };
    case "uncertain":
      return { ok: true, arrival: "held" };
    case "waiting":
    case "sending":
      return { ok: true, arrival: pending(facts, restart) };
  }
}

function pending(facts: MessageFacts, restart: boolean): MessageArrival {
  if (facts.held) return "held";
  if (restart) return "starting";
  if (facts.turnRunning) {
    if (facts.delivery !== "steer" || !facts.steers) return "queued";
    return facts.restartsTurn ? "restarting" : "steering";
  }
  if (!facts.acceptsInput) return "held";
  return facts.delivery === "queue" && facts.ahead > 0 ? "queued" : "starting";
}
