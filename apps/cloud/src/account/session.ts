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
 * other isolates, which get the stored account instead. The token is read only once the lease is
 * held, and what the refresh found (a rotated token, a refusal that ends the session) is written
 * only while that lease still is: a reader never spends or acts on a token another replaced.
 */
export function sessionReader(deps: {
  store: SessionStore;
  provider: Pick<AccountProvider, "refresh">;
  now: () => number;
}) {
  const { store, provider, now } = deps;
  const inflight = new Map<string, Promise<ActiveSession | undefined>>();

  const read = (hash: string, held: boolean) =>
    held ? store.held(hash, now()) : store.get(hash, now());
  const active = (stored: NonNullable<Awaited<ReturnType<typeof read>>>): ActiveSession => ({
    account: stored.account,
    expiresAt: stored.expiresAt,
    signedInAt: stored.signedInAt,
    standing: stored.standing,
  });

  async function refresh(hash: string, held: boolean): Promise<ActiveSession | undefined> {
    const lease = await store.lease(hash, now(), REFRESH_LEASE_MS);
    // Another reader is refreshing it: the stored account stands meanwhile.
    if (!lease) {
      const stored = await read(hash, held);
      return stored ? active(stored) : undefined;
    }
    // Read under the lease: a token read before it may be one the previous holder spent.
    const stored = await read(hash, held);
    if (!stored) {
      await store.release(hash, lease);
      return undefined;
    }
    let identity;
    try {
      identity = await provider.refresh(await stored.refresh());
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        if (await store.endLeased(hash, lease)) return undefined;
        // The lease ran out and another reader renewed the session with the token it spent.
        const current = await read(hash, held);
        return current ? active(current) : undefined;
      }
      await store.release(hash, lease);
      throw error;
    }
    if (now() >= stored.expiresAt || identity.account.id !== stored.account.id) {
      await store.endLeased(hash, lease);
      return undefined;
    }
    const expiresAt = Math.max(stored.expiresAt, now() + SESSION_LIFETIME_MS);
    const rotated = await store.rotate(
      hash,
      lease,
      identity.account,
      identity.refreshToken,
      expiresAt,
      identity.pictureUrl,
    );
    if (!rotated) {
      // Revoked meanwhile, or the lease ran out and another reader holds the session now.
      const current = await read(hash, held);
      return current ? active(current) : undefined;
    }
    return { ...active(stored), account: identity.account, expiresAt };
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
