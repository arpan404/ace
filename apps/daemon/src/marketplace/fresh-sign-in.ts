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

/** How far the backend's clock may run ahead of this daemon's for a sign-in time. */
export const signInSkewMs = 60_000;

/**
 * Whether market grant `grant` proves this machine's ace account signed in within ten minutes
 * (ADR 0178 §12.8). Only claims whose signature verifies against `keys` count: the keys this
 * build pins, never ones a caller or the environment can name. The grant must also be a machine
 * grant for this machine's account (`account`) and host (`subject`), so a grant minted for
 * another account or machine, or a device's, proves nothing here. The sign-in's age is measured
 * on this daemon's clock now (`now - authAt`), so a grant taken near the end of the ten minutes
 * can't be held for its five-minute life and replayed after them; a sign-in up to
 * `signInSkewMs` in the future is the backend's clock running ahead.
 */
export function verifiedSignInFresh(
  grant: string,
  trust: {
    readonly keys: GrantKeySet;
    readonly issuer: string;
    readonly now: number;
    readonly account: string;
    readonly subject: string;
  },
): boolean {
  try {
    const claims = verifyMarketGrant(grant, trust.keys, trust.now, trust.issuer);
    if (claims.kind !== "machine") return false;
    if (claims.account !== trust.account || claims.subject !== trust.subject) return false;
    const age = trust.now - claims.authAt;
    return age <= freshSignInMs && age >= -signInSkewMs;
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
