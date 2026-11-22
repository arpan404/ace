import type { StandingChallenge } from "@ace/client";
import { aceAccountClient } from "@ace/client/ace-account";
import {
  makeStandingKey,
  provePaired,
  proveStanding,
  type StandingKey,
} from "@ace/client/standing";
import { appStandingKey, type AppStandingKey } from "./app-standing-key.ts";
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

/**
 * The desktop app's own windows: its main process proves their sockets with the device key it
 * keeps in the OS keychain (ADR 0190, amendment 1), with no browser and no backend round trip.
 * The window only asks; main fetches the daemon's challenge, signs and sends the statement for
 * the sockets it tagged. Undefined for a socket main didn't tag, outside the desktop app, and
 * before the key is enrolled.
 */
export function appProver(app: AppStandingKey, origin: string | undefined): StandingProver {
  return async (challenge) =>
    origin && challenge.appSocket === true && (await app.prove(origin))
      ? { type: "proven" }
      : undefined;
}

/**
 * Once a desktop window proved the owner's grant on a socket main tagged, main may enroll the
 * device key, if a browser sign-in just happened (main knows; the window can't say so). The
 * first Confirm it's you is the only one: every socket after proves with the key.
 */
export function enrollAppKey(app: AppStandingKey, origin: string | undefined) {
  return async (challenge: StandingChallenge): Promise<void> => {
    if (origin && challenge.appSocket === true) await app.enroll(origin);
  };
}

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
  const app = paired ? undefined : appStandingKey();
  const origin = accountOrigin();
  const keeper = paired
    ? keepStanding(client, pairedProver, timers, windowProver)
    : app
      ? keepStanding(
          client,
          appProver(app, origin),
          timers,
          windowProver,
          enrollAppKey(app, origin),
        )
      : keepStanding(client, windowProver, timers);
  keepers.set(client, keeper.proveNow);
  return client;
}

/** Proves again on the connection that needs this window's standing. */
export async function proveAgain(client: ClientApi): Promise<boolean> {
  return (await keepers.get(client)?.()) ?? false;
}
