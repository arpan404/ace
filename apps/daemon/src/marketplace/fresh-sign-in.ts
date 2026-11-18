import { verifyMarketGrant, type GrantKeySet } from "@ace/account-grant";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";

/*
 * The host token (`ACE_HOME/daemon-token`) is the person's whole authority: any process that
 * can read it acts as the person, an unsandboxed coding agent included. So for person-only
 * market actions, the host token alone isn't enough (ADR 0178 §12.5): they need the app or a
 * paired device, or an ace sign-in from the last ten minutes, which takes the person in a
 * browser (ADR 0174 §2's rule). The desktop app's page holds the host token too, and proves it
 * is the app with the key the app gave its daemon (§12.8), so it isn't "the host token alone".
 * Pure.
 */

/** ADR 0174 §2: a sensitive action needs a sign-in this recent. */
export const freshSignInMs = 10 * 60_000;

/** Says what to do: the code stays `reauth`, so a client can offer its sign-in. */
export const reauthSentence =
  "This needs the ace app, a paired device or a recent sign-in. Sign in to ace again (ace login), then do it within 10 minutes.";

/**
 * The market's own refusal of a stale sign-in (ADR 0174 §2), which no client of this daemon
 * can skip: withdraw, transfers, handle changes and verified-profile edits check it at the
 * market, from the app too.
 */
export const marketReauthSentence =
  "Sign in again to do this: the market needs a sign-in from the last 10 minutes. Sign in to ace again (ace login), then try it again.";

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
 * Whether market grant `grant` says the session behind it signed in within ten minutes, read
 * only from claims whose signature verifies against `keys` with `issuer`: the keys and issuer
 * of the account backend this daemon was started with, never ones a caller can name. A grant
 * that doesn't verify (unsigned, signed by another key, expired, another issuer) is not fresh.
 */
export function verifiedSignInFresh(
  grant: string,
  trust: { readonly keys: GrantKeySet; readonly issuer: string; readonly now: number },
): boolean {
  try {
    const claims = verifyMarketGrant(grant, trust.keys, trust.now, trust.issuer);
    return signedInRecently(claims.iat - claims.authAt);
  } catch {
    return false;
  }
}

/**
 * The refusal for a market request a socket whose credential isn't the person's makes without
 * naming a thread, or undefined when it may run. The app's page, devices the person paired and
 * account devices pass as they are.
 */
export async function hostMarketRefusal(input: {
  readonly operation: MarketOperation;
  /** The socket's credential isn't the person's (`personProven`, ADR 0178 §12.8). */
  readonly unproven: boolean;
  readonly fresh: () => Promise<boolean>;
}): Promise<MarketResult | undefined> {
  if (!input.unproven || !needsFreshSignIn(input.operation)) return undefined;
  if (await input.fresh()) return undefined;
  return { op: "error", code: "reauth", message: reauthSentence };
}
