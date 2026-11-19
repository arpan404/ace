import type { StandingChallenge } from "@ace/client";
import { aceAccountClient, standingProofText } from "@ace/client/ace-account";
import { accountFetch, accountOrigin, windowAccountSession } from "./account-config.ts";
import { keepStanding, type StandingProver } from "./standing-keeper.ts";
import { makeStandingKey, type StandingKey } from "./standing-key.ts";
import { windowSessionStorage } from "./window-session.ts";
import type { ClientApi } from "@ace/client";

/** This window's device key, made once and kept in its memory only (ADR 0190). */
let windowKey: Promise<StandingKey> | undefined;
/** Every socket this window keeps proving on, to prove again at once after a sign-in. */
const keepers = new Set<() => Promise<void>>();

/**
 * This window's proof of the person's standing (ADR 0190): a person's grant for the challenge's
 * daemon and device, asked for with this window's own ace session (in its memory only), and this
 * window's key's signature over the challenge. Undefined while the window holds no session.
 */
export const windowProver: StandingProver = async (challenge: StandingChallenge) => {
  const origin = accountOrigin();
  const session = origin ? windowAccountSession(windowSessionStorage(), origin) : null;
  if (!origin || !session) return undefined;
  windowKey ??= makeStandingKey();
  const key = await windowKey;
  const grant = await aceAccountClient({ origin, fetch: accountFetch(origin) }).grant(
    session.token,
    { kind: "device", subject: challenge.device, host: challenge.host, key: key.publicKey },
    AbortSignal.timeout(15_000),
  );
  if (!grant.standing) return undefined;
  const proof = await key.sign(
    standingProofText({
      host: challenge.host,
      nonce: challenge.nonce,
      binding: challenge.binding,
      grant: grant.standing,
    }),
  );
  return { grant: grant.standing, proof };
};

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** Keeps `client`'s sockets proving the person's standing for as long as it lives. */
export function proveFromWindow(client: ClientApi): ClientApi {
  const keeper = keepStanding(client, windowProver, timers);
  keepers.add(keeper.proveNow);
  return client;
}

/** Proves again on every socket now: the window just signed in as the person. */
export async function proveAgain(): Promise<void> {
  await Promise.all([...keepers].map((prove) => prove()));
}
