import type { StandingChallenge } from "@ace/client";
import { aceAccountClient } from "@ace/client/ace-account";
import {
  makeStandingKey,
  provePaired,
  proveStanding,
  type StandingKey,
} from "@ace/client/standing";
import { accountFetch, accountOrigin, windowAccountSession } from "./account-config.ts";
import { keepStanding, type StandingProver } from "./standing-keeper.ts";
import { windowSessionStorage } from "./window-session.ts";
import type { ClientApi } from "@ace/client";

/** This window's device key, made once and kept in its memory only (ADR 0190). */
let windowKey: Promise<StandingKey> | undefined;
/** Every socket this window keeps proving on, to prove again at once after a sign-in. */
const keepers = new WeakMap<ClientApi, () => Promise<boolean>>();

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
  const proven = await proveStanding({
    challenge,
    session: session.token,
    account: aceAccountClient({ origin, fetch: accountFetch(origin) }),
    key: await windowKey,
  });
  return proven && { type: "account.standing", ...proven };
};

/**
 * A device paired from a person's link proves with the key this browser kept for it (ADR 0190),
 * with its own challenge signature.
 */
const pairedProver: StandingProver = async (challenge) => {
  const { pairedStandingKey } = await import("./paired-standing-key.ts");
  const key = await pairedStandingKey().catch(() => undefined);
  if (!key) return undefined;
  return { type: "device.standing", proof: await provePaired({ challenge, key }) };
};

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/**
 * Keeps `client`'s sockets proving the person's standing for as long as it lives; `paired`: it
 * connects as a device this browser paired.
 */
export function proveFromWindow(client: ClientApi, paired = false): ClientApi {
  const keeper = paired
    ? keepStanding(client, pairedProver, timers, windowProver)
    : keepStanding(client, windowProver, timers);
  keepers.set(client, keeper.proveNow);
  return client;
}

/** Proves again on the connection that needs this window's standing. */
export async function proveAgain(client: ClientApi): Promise<boolean> {
  return (await keepers.get(client)?.()) ?? false;
}
