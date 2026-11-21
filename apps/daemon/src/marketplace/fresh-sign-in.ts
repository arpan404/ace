import { isPersonOnlyAction, isPersonOnlyOperation } from "@ace/marketplace/person-only";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";

/*
 * Who may do a person-only market action (ADR 0178 §12.5, ADR 0190). The host token
 * (`ACE_HOME/daemon-token`) is readable by any process of the person's, an unsandboxed coding
 * agent included, and so is everything else in ACE_HOME. A sign-in that happened lately proves
 * nothing about who is asking now, so it authorizes nothing: only a socket that proved the
 * person's standing (an ace app signed in as the person, a device paired from a link the person
 * made) does these. Pure.
 */

export const reauthSentence = "Confirm your identity to continue.";

/**
 * The daemon's person-only operations (`personOnlyOperations`: install, turning a skill on for
 * bots), and the publish actions the market takes only from the person (`personOnlyActions`:
 * withdraw, transfers and answering one, handle changes, deleting an entry and verification).
 */
export function needsPerson(operation: MarketOperation): boolean {
  if (isPersonOnlyOperation(operation.op)) return true;
  return operation.op === "publish" && isPersonOnlyAction(operation.request.action);
}

/**
 * What a market request a socket makes without naming a thread may do (ADR 0190, ADR 0178 §12.8):
 * run with the person's standing, run without it, or be refused. A socket that proved the person's
 * standing runs anything. One that hasn't runs what isn't person-only, and installing or updating
 * content only (a Suit or a Spade skill that runs nothing, read from the daemon's own review), as
 * the `without-person` path: a Spade skill it installs reaches no bot until the person turns it
 * on. Everything else person-only is refused with `reauth`. Pure.
 */
export function hostMarketStanding(input: {
  readonly operation: MarketOperation;
  /** The socket hasn't proved the person's standing (ADR 0190). */
  readonly unproven: boolean;
  /** For an install: whether its review installs content only (`content-only.ts`). */
  readonly contentOnly: () => boolean;
}): { readonly run: "person" | "without-person" } | { readonly refusal: MarketResult } {
  if (!input.unproven) return { run: "person" };
  if (!needsPerson(input.operation)) return { run: "without-person" };
  if (input.operation.op === "install" && input.contentOnly()) return { run: "without-person" };
  return { refusal: { op: "error", code: "reauth", message: reauthSentence } };
}
