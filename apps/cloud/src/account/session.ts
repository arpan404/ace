import type { AceAccount } from "@ace/protocol/ace-account";
import { digest } from "./crypto.ts";
import { SESSION_LIFETIME_MS } from "./login.ts";
import type { SessionStanding, SessionStore } from "./sessions.ts";
import { InvalidGrantError } from "./workos.ts";
import type { AccountProvider } from "./workos.ts";

/**
 * `signedInAt`: when the person signed in for this session (0 for sessions from before it was
 * kept). `standing`: whether it may still speak for the person (ADR 0190).
 */
export type ActiveSession = {
  account: AceAccount;
  expiresAt: number;
  signedInAt: number;
  standing: SessionStanding;
};

/** How long one reader may spend a session's refresh token before another may try. */
const REFRESH_LEASE_MS = 15_000;

/**
 * Reads an ace session, refreshing it with WorkOS each time so a revoked or deleted WorkOS
 * user loses access. Each refresh renews the session for another `SESSION_LIFETIME_MS`, so a
 * session in use never lapses; one left unused that long does. WorkOS refresh tokens are single-use, so concurrent reads must not spend
 * the same one: readers in this isolate share one refresh, and a D1 lease stops readers in
 * other isolates, which get the stored account instead.
 */
export function sessionReader(deps: {
  store: SessionStore;
  provider: Pick<AccountProvider, "refresh">;
  now: () => number;
}) {
  const { store, provider, now } = deps;
  const inflight = new Map<string, Promise<ActiveSession | undefined>>();

  async function refresh(hash: string, held: boolean): Promise<ActiveSession | undefined> {
    const stored = held ? await store.held(hash, now()) : await store.get(hash, now());
    if (!stored) return undefined;
    if (!(await store.lease(hash, now(), REFRESH_LEASE_MS)))
      return {
        account: stored.account,
        expiresAt: stored.expiresAt,
        signedInAt: stored.signedInAt,
        standing: stored.standing,
      };
    let identity;
    try {
      identity = await provider.refresh(await stored.refresh());
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        await store.remove(hash);
        return undefined;
      }
      await store.release(hash);
      throw error;
    }
    if (now() >= stored.expiresAt || identity.account.id !== stored.account.id) {
      await store.remove(hash);
      return undefined;
    }
    const expiresAt = Math.max(stored.expiresAt, now() + SESSION_LIFETIME_MS);
    const rotated = await store.rotate(
      hash,
      identity.account,
      identity.refreshToken,
      expiresAt,
      identity.pictureUrl,
    );
    if (!rotated) return undefined;
    return {
      account: identity.account,
      expiresAt,
      signedInAt: stored.signedInAt,
      standing: stored.standing,
    };
  }

  /** `held`: read for a machine credential, which a retired session still serves. */
  async function readHash(hash: string, held = false): Promise<ActiveSession | undefined> {
    const key = `${held ? "held" : "token"}:${hash}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const run = refresh(hash, held);
    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    /** The session a bearer token opens: never a retired one (ADR 0190). */
    async read(token: string): Promise<ActiveSession | undefined> {
      return readHash(await digest(token));
    },
    /** By the token's digest; `held` for the session a machine credential lives on. */
    readHash,
    async revoke(token: string) {
      await store.remove(await digest(token));
    },
  };
}
export type SessionReader = ReturnType<typeof sessionReader>;
