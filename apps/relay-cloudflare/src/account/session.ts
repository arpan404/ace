import type { AceAccount } from "@ace/protocol/ace-account";
import { digest } from "./crypto.ts";
import type { SessionStore } from "./sessions.ts";
import { InvalidGrantError } from "./workos.ts";
import type { AccountProvider } from "./workos.ts";

export type ActiveSession = { account: AceAccount; expiresAt: number };

/** How long one reader may spend a session's refresh token before another may try. */
const REFRESH_LEASE_MS = 15_000;

/**
 * Reads an ace session, refreshing it with WorkOS each time so a revoked or deleted WorkOS
 * user loses access. WorkOS refresh tokens are single-use, so concurrent reads must not spend
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

  async function refresh(hash: string): Promise<ActiveSession | undefined> {
    const stored = await store.get(hash, now());
    if (!stored) return undefined;
    if (!(await store.lease(hash, now(), REFRESH_LEASE_MS)))
      return { account: stored.account, expiresAt: stored.expiresAt };
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
    if (!(await store.rotate(hash, identity.account, identity.refreshToken))) return undefined;
    return { account: identity.account, expiresAt: stored.expiresAt };
  }

  return {
    async read(token: string): Promise<ActiveSession | undefined> {
      const hash = await digest(token);
      const pending = inflight.get(hash);
      if (pending) return pending;
      const run = refresh(hash);
      inflight.set(hash, run);
      try {
        return await run;
      } finally {
        inflight.delete(hash);
      }
    },
    async revoke(token: string) {
      await store.remove(await digest(token));
    },
  };
}
export type SessionReader = ReturnType<typeof sessionReader>;
