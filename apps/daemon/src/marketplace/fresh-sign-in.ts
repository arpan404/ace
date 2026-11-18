import { verifyMarketGrant, type GrantKeySet } from "@ace/account-grant";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";

/*
 * The host token (`ACE_HOME/daemon-token`) is the person's whole authority: any process that
 * can read it acts as the person, an unsandboxed coding agent included. So for person-only
 * market actions, the host token alone isn't enough (ADR 0178 §12.5): they need the app or a
 * paired device, or an ace sign-in from the last ten minutes, which takes the person in a
 * browser (ADR 0174 §2's rule). Pure.
 */

/** ADR 0174 §2: a sensitive action needs a sign-in this recent. */
export const freshSignInMs = 10 * 60_000;

export const reauthSentence =
  "Do this in the app or on a paired device, or sign in to ace again (ace login) and do it within 10 minutes.";

/** Install, withdraw, transfers, handle changes, deleting an entry and verification. */
export function needsFreshSignIn(operation: MarketOperation): boolean {
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
 * Whether market grant `grant` proves this machine's ace account signed in in a browser within
 * ten minutes (ADR 0174 §2, ADR 0190). Only claims a key this build pins signed count, never ones
 * the session's origin or the environment can name; the grant must be a machine grant for this
 * account and this machine's relay host id; and the sign-in's age is measured on this daemon's
 * clock now, so a grant held after it was taken can't stretch the ten minutes. A sign-in up to a
 * minute ahead is the backend's clock running ahead. Pure.
 */
export function verifiedSignInFresh(
  grant: string,
  trust: { keys: GrantKeySet; issuer: string; now: number; account: string; subject: string },
): boolean {
  try {
    const claims = verifyMarketGrant(grant, trust.keys, trust.now, trust.issuer);
    if (claims.kind !== "machine") return false;
    if (claims.account !== trust.account || claims.subject !== trust.subject) return false;
    const age = trust.now - claims.authAt;
    return age <= freshSignInMs && age >= -60_000;
  } catch {
    return false;
  }
}

/**
 * The refusal for a market request a host-token socket makes without naming a thread, or
 * undefined when it may run. The app and paired devices aren't host-token sockets.
 */
export async function hostMarketRefusal(input: {
  readonly operation: MarketOperation;
  /**
   * The socket's credential isn't the person's: the host token, or an account device whose
   * standing grant didn't say person (ADR 0190).
   */
  readonly unproven: boolean;
  readonly fresh: () => Promise<boolean>;
}): Promise<MarketResult | undefined> {
  if (!input.unproven || !needsFreshSignIn(input.operation)) return undefined;
  if (await input.fresh()) return undefined;
  return { op: "error", code: "reauth", message: reauthSentence };
}
