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
 * Whether a sign-in `age` milliseconds before its grant was issued counts as fresh. A small
 * negative age is the backend's own rounding; a large one is a malformed grant.
 */
export function signedInRecently(age: number | undefined): boolean {
  return age !== undefined && age <= freshSignInMs && age >= -60_000;
}

/**
 * The refusal for a market request a host-token socket makes without naming a thread, or
 * undefined when it may run. The app and paired devices aren't host-token sockets.
 */
export async function hostMarketRefusal(input: {
  readonly operation: MarketOperation;
  /**
   * The socket's credential isn't the person's: the host token, or an account device whose
   * standing grant didn't say person (ADR 0189).
   */
  readonly unproven: boolean;
  readonly fresh: () => Promise<boolean>;
}): Promise<MarketResult | undefined> {
  if (!input.unproven || !needsFreshSignIn(input.operation)) return undefined;
  if (await input.fresh()) return undefined;
  return { op: "error", code: "reauth", message: reauthSentence };
}
