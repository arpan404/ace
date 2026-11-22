import {
  enrollAction,
  possessionHolds,
  socketsTarget,
  x25519Ephemeral,
  x25519Shared,
} from "@ace/account-grant/app-channel";
import { statementText, type PersonStatement } from "@ace/account-grant/person-statement";
import {
  APP_STANDING_MAX_SOCKETS,
  AppStandingChallenge,
  AppStandingResult,
  type AppSocket,
} from "@ace/protocol";
import type { DeviceKey, StandingKeys } from "./standing-key.ts";
import { sessionDigest } from "./standing-key.ts";

/*
 * Main's side of the person's standing on the app's own sockets (ADR 0190, amendment 1). A page
 * may only ask "prove me" or "enroll". Main fetches the daemon's challenge itself, with an
 * ephemeral key the daemon must answer with the relay key main pinned; signs a person's statement
 * for the live sockets behind the tags it put on the app's own socket upgrades, in batches the
 * statement's limit allows; and sends it. Enrolling needs the account backend to vouch for a
 * browser sign-in from the last ten minutes, and main counts a sign-in only when a new session
 * arrives, never a rewrite of the same one. Signing out keeps the revocation until the daemon
 * acknowledges it. Everything runs one step at a time, so an enrollment never lands after a
 * sign-out.
 */

/** How recent a browser sign-in must be for main to try to enroll this device's key. */
export const ENROLL_WINDOW_MS = 10 * 60_000;
/** How long a statement main makes may live: one exchange. */
const STATEMENT_MS = 30_000;

/** The daemon on this computer, over HTTP with the host token and no redirects. */
export type DaemonHttp = (
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

/** The daemon on this computer as main reaches it. */
export interface LocalDaemon {
  http: DaemonHttp;
  /** The relay host id its home's key proves, which statements name. */
  host: string;
  /** That key's public half as the home has it now: pinned at the first enrollment only. */
  relayPublicKey: string | undefined;
}

/**
 * The daemon's challenge for `tags`, if it proves it holds the relay key `pinned`: an HMAC keyed
 * by the X25519 secret between that key and a fresh ephemeral one, over the whole challenge.
 */
async function challenge(daemon: LocalDaemon, tags: readonly string[], pinned: string) {
  const ephemeral = x25519Ephemeral();
  const answer = await daemon.http("POST", "/v1/standing/app/challenge", {
    ephemeral: Buffer.from(ephemeral.publicKey).toString("base64url"),
    tags,
  });
  const parsed = AppStandingChallenge.safeParse(answer.body);
  if (answer.status !== 200 || !parsed.success || parsed.data.host !== daemon.host)
    return undefined;
  const shared = x25519Shared(ephemeral.privateKey, Buffer.from(pinned, "base64url"));
  return possessionHolds(shared, parsed.data, parsed.data.possession) ? parsed.data : undefined;
}

export function appStanding(deps: {
  keys: StandingKeys;
  /** Whether this run may keep a key (`app-standing-gate.ts`). */
  allowed(): Promise<boolean>;
  /** The tags main put on the app's own socket upgrades. */
  tags(): readonly string[];
  /** The daemon on this computer; undefined for a remote daemon or none. */
  daemon(): Promise<LocalDaemon | undefined>;
  /** The app's saved session at `origin`. */
  session(origin: string): Promise<string | null>;
  /** The account a session is, as the backend says. */
  accountOf(origin: string, token: string): Promise<string>;
  /**
   * A grant the backend mints from the session at `origin` for `action`, carrying when that
   * session signed in: the backend's word that the enrollment follows a browser sign-in.
   */
  signInGrant(origin: string, token: string, action: string): Promise<string>;
  now(): number;
}) {
  /** When the browser last brought a new session, per account origin. */
  const signedInAt = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  /** One step at a time: proofs, enrollments, sign-ins, sign-outs and revocations. */
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
  const statement = (
    key: DeviceKey,
    purpose: PersonStatement["purpose"],
    asked: AppStandingChallenge,
    sockets: readonly AppSocket[],
  ) => {
    const now = deps.now();
    return statementText({
      account: key.account,
      device: key.id,
      purpose,
      action: "socket",
      target: socketsTarget(sockets),
      audience: asked.host,
      nonce: asked.nonce,
      iat: now,
      exp: now + STATEMENT_MS,
    });
  };
  /** Proves every tagged socket with `key`, a batch per statement: how many took it. */
  const proveAll = async (origin: string, key: DeviceKey, daemon: LocalDaemon, pinned: string) => {
    const tags = deps.tags();
    let proven = 0;
    for (let start = 0; start < tags.length; start += APP_STANDING_MAX_SOCKETS) {
      const batch = tags.slice(start, start + APP_STANDING_MAX_SOCKETS);
      const asked = await challenge(daemon, batch, pinned);
      if (!asked || asked.owner !== key.account || !asked.sockets.length) continue;
      const text = statement(key, "standing", asked, asked.sockets);
      const proof = await deps.keys.sign(origin, text);
      if (!proof) return proven;
      const answer = await daemon.http("POST", "/v1/standing/app/prove", {
        statement: text,
        proof,
        key: key.publicKey,
        sockets: asked.sockets,
      });
      const result = AppStandingResult.safeParse(answer.body);
      if (answer.status === 200 && result.success) proven += result.data.proven;
    }
    return proven;
  };
  /** The key kept for `origin`, while the session it was enrolled under is still the app's. */
  const current = async (origin: string): Promise<DeviceKey | undefined> => {
    const key = await deps.keys.held(origin);
    const token = await deps.session(origin);
    return key && token && sessionDigest(token) === key.session ? key : undefined;
  };
  /** Sends every revocation the daemon hasn't acknowledged; keeps any it didn't. */
  const flush = async () => {
    const pending = await deps.keys.pending().catch((): readonly string[] => []);
    if (!pending.length) return;
    const daemon = await deps.daemon().catch(() => undefined);
    if (!daemon) return;
    for (const publicKey of pending) {
      const answer = await daemon
        .http("DELETE", "/v1/standing/app/key", { key: publicKey })
        .catch(() => undefined);
      if (answer?.status === 200) await deps.keys.acknowledged(publicKey);
    }
  };
  const prove = async (origin: string): Promise<boolean> => {
    await flush();
    if (!(await deps.allowed())) return false;
    const key = await current(origin);
    const daemon = await deps.daemon();
    const pinned = await deps.keys.pin();
    if (!key || !daemon || !pinned) return false;
    return (await proveAll(origin, key, daemon, pinned)) > 0;
  };
  /** Signing out of `origin`, or another session arriving: the key is revoked, durably. */
  const revoke = async (origin: string) => {
    await deps.keys.revokeLater(origin);
    await flush();
  };
  return {
    /** "Prove me": the app's own sockets get the person's standing from this device's key. */
    prove: (origin: string) => serial(() => prove(origin)),
    /**
     * "Enroll": right after a browser sign-in, this device's key becomes the owner's, from a
     * socket of the app's that proved the owner's grant, with the backend's word on the
     * sign-in; then it proves.
     */
    enroll: (origin: string) =>
      serial(async () => {
        await flush();
        if (!(await deps.allowed())) return false;
        const at = signedInAt.get(origin);
        if (at === undefined || deps.now() - at > ENROLL_WINDOW_MS) return false;
        const token = await deps.session(origin);
        const daemon = await deps.daemon();
        if (!token || !daemon) return false;
        // Pinned at the first enrollment, and kept: the home's key is never trusted over it.
        const pinned = (await deps.keys.pin()) ?? daemon.relayPublicKey;
        if (!pinned) return false;
        const account = await deps.accountOf(origin, token);
        const tags = deps.tags().slice(-APP_STANDING_MAX_SOCKETS);
        const asked = await challenge(daemon, tags, pinned);
        if (!asked || asked.owner !== account || !asked.sockets.length) return false;
        // A key kept from before is revoked first: one enrolled key per backend, never two.
        if (await deps.keys.held(origin)) await revoke(origin);
        const key = await deps.keys.make(origin, account, sessionDigest(token));
        const text = statement(key, "enroll", asked, asked.sockets);
        const proof = await deps.keys.sign(origin, text);
        const signIn = await deps.signInGrant(
          origin,
          token,
          enrollAction({ host: asked.host, device: key.id, nonce: asked.nonce }),
        );
        const answer = proof
          ? await daemon.http("POST", "/v1/standing/app/key", {
              statement: text,
              proof,
              key: key.publicKey,
              sockets: asked.sockets,
              signIn,
            })
          : undefined;
        if (answer?.status !== 200) {
          await deps.keys.forget(origin);
          return false;
        }
        await deps.keys.setPin(pinned);
        return prove(origin);
      }),
    /**
     * A session was written for `origin`. Only a new session is a sign-in: one that differs
     * from `previous`, the session saved before. Rewriting the same session counts for nothing.
     * A key made under another session is revoked.
     */
    signedIn: (origin: string, token: string, previous: string | null) =>
      serial(async () => {
        if (token === previous) return;
        signedInAt.set(origin, deps.now());
        const key = await deps.keys.held(origin).catch(() => undefined);
        if (key && key.session !== sessionDigest(token)) await revoke(origin);
      }),
    /** Signed out: the key's revocation waits durably until the daemon acknowledges it. */
    signedOut: (origin: string) =>
      serial(async () => {
        signedInAt.delete(origin);
        await revoke(origin);
      }),
    /** Sends any revocation still waiting: at start, and before every step. */
    retry: () => serial(flush),
  };
}
export type AppStanding = ReturnType<typeof appStanding>;
