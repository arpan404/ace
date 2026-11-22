import { statementText, type PersonStatement } from "@ace/account-grant/person-statement";
import { AppStandingChallenge, AppStandingResult } from "@ace/protocol";
import type { DeviceKey, StandingKeys } from "./standing-key.ts";
import { sessionDigest } from "./standing-key.ts";

/*
 * Main's side of the person's standing on the app's own sockets (ADR 0190, amendment 1). A page
 * may only ask "prove me" or "enroll": main fetches the daemon's challenge itself, signs a
 * person's statement for the tags it put on the app's own socket upgrades, and sends it. A page
 * never hands main a challenge, an account or a socket. Enrolling a key follows a browser
 * sign-in only, and signing out (or another sign-in) revokes the key at the daemon.
 */

/** How recent a browser sign-in must be to enroll this device's key. */
export const ENROLL_WINDOW_MS = 10 * 60_000;
/** How long a statement main makes may live: one exchange. */
const STATEMENT_MS = 30_000;

/** The daemon on this computer, over HTTP with the host token. */
export type DaemonHttp = (
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

export function appStanding(deps: {
  keys: StandingKeys;
  /** Whether this run may keep a key (`app-standing-gate.ts`). */
  allowed(): Promise<boolean>;
  /** The tags main put on the app's own socket upgrades. */
  tags(): readonly string[];
  /**
   * The daemon on this computer, and the relay host id its home's key proves (ADR 0190), which
   * statements name. Undefined for a remote daemon or none.
   */
  daemon(): Promise<{ http: DaemonHttp; host: string } | undefined>;
  /** The app's saved session at `origin`. */
  session(origin: string): Promise<string | null>;
  /** The account a session is, as the backend says. */
  accountOf(origin: string, token: string): Promise<string>;
  now(): number;
}) {
  /** When the browser last signed in, per account origin. */
  const signedInAt = new Map<string, number>();
  const challenge = async (daemon: { http: DaemonHttp; host: string }) => {
    const answer = await daemon.http("POST", "/v1/standing/app/challenge");
    const parsed = AppStandingChallenge.safeParse(answer.body);
    // Only the daemon whose relay key this app read: never one answering in its place.
    return answer.status === 200 && parsed.success && parsed.data.host === daemon.host
      ? parsed.data
      : undefined;
  };
  const send = async (
    origin: string,
    key: DeviceKey,
    purpose: PersonStatement["purpose"],
  ): Promise<number | undefined> => {
    const daemon = await deps.daemon();
    const tags = deps.tags();
    if (!daemon || !tags.length) return undefined;
    const asked = await challenge(daemon);
    if (!asked || asked.owner !== key.account) return undefined;
    const now = deps.now();
    const text = statementText({
      account: key.account,
      device: key.id,
      purpose,
      action: "socket",
      target: tags.join(","),
      audience: asked.host,
      nonce: asked.nonce,
      iat: now,
      exp: now + STATEMENT_MS,
    });
    const proof = await deps.keys.sign(origin, text);
    if (!proof) return undefined;
    const path = purpose === "enroll" ? "/v1/standing/app/key" : "/v1/standing/app/prove";
    const answer = await daemon.http("POST", path, {
      statement: text,
      proof,
      key: key.publicKey,
    });
    const result = AppStandingResult.safeParse(answer.body);
    return answer.status === 200 && result.success ? result.data.proven : undefined;
  };
  /** The key kept for `origin`, while the session it was enrolled under is still the app's. */
  const current = async (origin: string): Promise<DeviceKey | undefined> => {
    const key = await deps.keys.held(origin);
    const token = await deps.session(origin);
    return key && token && sessionDigest(token) === key.session ? key : undefined;
  };
  const revoke = async (origin: string, key: DeviceKey) => {
    const daemon = await deps.daemon().catch(() => undefined);
    await daemon
      ?.http("DELETE", "/v1/standing/app/key", { key: key.publicKey })
      .catch(() => undefined);
    await deps.keys.forget(origin);
  };
  const prove = async (origin: string): Promise<boolean> => {
    if (!(await deps.allowed())) return false;
    const key = await current(origin);
    return key !== undefined && ((await send(origin, key, "standing")) ?? 0) > 0;
  };
  return {
    /** "Prove me": the app's own sockets get the person's standing from this device's key. */
    prove,
    /**
     * "Enroll": right after a browser sign-in, this device's key becomes the owner's, from a
     * socket of the app's that proved the owner's grant; then it proves.
     */
    async enroll(origin: string): Promise<boolean> {
      if (!(await deps.allowed())) return false;
      const at = signedInAt.get(origin);
      if (at === undefined || deps.now() - at > ENROLL_WINDOW_MS) return false;
      const token = await deps.session(origin);
      if (!token) return false;
      const account = await deps.accountOf(origin, token);
      const key = await deps.keys.make(origin, account, sessionDigest(token));
      if ((await send(origin, key, "enroll")) === undefined) {
        await deps.keys.forget(origin);
        return false;
      }
      return prove(origin);
    },
    /** A browser sign-in finished: a key made under another session is revoked. */
    async signedIn(origin: string, token: string): Promise<void> {
      signedInAt.set(origin, deps.now());
      const key = await deps.keys.held(origin).catch(() => undefined);
      if (key && key.session !== sessionDigest(token)) await revoke(origin, key);
    },
    /** Signed out: the key is revoked at the daemon, which ends the standing it gave, and forgotten. */
    async signedOut(origin: string): Promise<void> {
      signedInAt.delete(origin);
      const key = await deps.keys.held(origin).catch(() => undefined);
      if (key) await revoke(origin, key);
      else await deps.keys.forget(origin);
    },
  };
}
export type AppStanding = ReturnType<typeof appStanding>;
