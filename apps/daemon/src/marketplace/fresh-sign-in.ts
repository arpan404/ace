import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";

/*
 * Who may do a person-only market action (ADR 0178 §12.5, ADR 0190). The host token
 * (`ACE_HOME/daemon-token`) is readable by any process of the person's, an unsandboxed coding
 * agent included, and so is everything else in ACE_HOME. A sign-in that happened lately proves
 * nothing about who is asking now, so it authorizes nothing: only a socket that proved the
 * person's standing (an ace app signed in as the person, a device paired from a link the person
 * made) does these. Pure.
 */

export const reauthSentence =
  "This is yours to do: do it in the ace app signed in as you, or on a device you paired from it.";

/** Install, withdraw, transfers, handle changes, deleting an entry and verification. */
export function needsPerson(operation: MarketOperation): boolean {
  if (operation.op === "install") return true;
  if (operation.op !== "publish") return false;
  switch (operation.request.action) {
    case "withdraw":
    case "transfer":
    case "transferAnswer":
    case "changeHandle":
    case "deleteEntry":
    case "applyVerification":
    case "checkVerification":
      return true;
    default:
      return false;
  }
}

/**
 * The refusal for a person-only market request from a socket that hasn't proved the person's
 * standing, or undefined when it may run. `reauth`: the app answers it by signing in as the
 * person, after which its socket proves it.
 */
export function hostMarketRefusal(input: {
  readonly operation: MarketOperation;
  /** The socket hasn't proved the person's standing (ADR 0190). */
  readonly unproven: boolean;
}): MarketResult | undefined {
  if (!input.unproven || !needsPerson(input.operation)) return undefined;
  return { op: "error", code: "reauth", message: reauthSentence };
}
