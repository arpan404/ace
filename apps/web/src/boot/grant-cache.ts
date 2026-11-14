/** A device grant as the account backend returns it: the token and when it runs out. */
export interface FetchedGrant {
  token: string;
  /** Epoch milliseconds, on the backend's clock. */
  expiresAt: number;
}

/**
 * A grant with less than this left is not offered again. It stays above the grant keeper's
 * refresh lead (60 s, `GRANT_REFRESH_LEAD_MS`), so a socket's refresh never gets back the
 * grant it is replacing.
 */
export const grantReuseMarginMs = 120_000;
/**
 * The longest a device grant lives (ADR 0111: five minutes). However late the browser's clock
 * is, a kept grant is never thought to live longer than this from when it was fetched.
 */
export const grantLifetimeCapMs = 300_000;

export interface GrantCache {
  /** The grant for `session`: the kept one while it may still be used, else a fresh one. */
  grant(session: string): Promise<string>;
  /**
   * The daemon or the relay refused `grant`: if it is still the kept one, it is never offered
   * again; any other grant (one already replaced, another machine's newer one) stays. True when
   * it was offered again from the cache after the attempt it was fetched for, so a fresh grant
   * may be worth one more try; false for a grant refused in the attempt it was fetched for,
   * which a fresh one would not change.
   */
  refused(grant: string): boolean;
  /** Sign-out: forget every grant. */
  clear(): void;
}

/**
 * Device grants for one window, in memory only (ADR 0114, ADR 0150): a connect, every path of
 * its race and a reconnect soon after share one grant instead of each asking the account
 * backend; concurrent asks share one fetch. A grant is kept for one ace session only: another
 * session (an account switch) or a sign-out forgets it. How long it is kept is measured on
 * `elapsed`, a clock that only moves forward (`performance.now`), from the time it was fetched,
 * never on the wall clock alone, so a browser clock minutes off cannot stretch it. The daemon's
 * or the relay's refusal is the authority: a refused grant is dropped at once.
 */
export function grantCache(
  fetch: (session: string) => Promise<FetchedGrant>,
  clocks: { wall(): number; elapsed(): number },
): GrantCache {
  /** The kept grant; `uses` counts the times it was offered again from the cache. */
  let kept: { session: string; token: string; usableUntil: number; uses: number } | undefined;
  let pending: { session: string; grant: Promise<string> } | undefined;
  return {
    async grant(session) {
      if (kept && kept.session !== session) kept = undefined;
      if (kept && clocks.elapsed() < kept.usableUntil) {
        kept.uses++;
        return kept.token;
      }
      kept = undefined;
      if (pending?.session !== session) {
        const fetchedAt = clocks.elapsed();
        const wall = clocks.wall();
        const asked = {
          session,
          grant: fetch(session).then((grant) => {
            // Its life from now: what the backend says, as the wall clock reads it, but never
            // past the most any grant lives.
            const life = Math.min(grant.expiresAt - wall, grantLifetimeCapMs);
            if (pending === asked) pending = undefined;
            kept = {
              session,
              token: grant.token,
              usableUntil: fetchedAt + life - grantReuseMarginMs,
              uses: 0,
            };
            return grant.token;
          }),
        };
        pending = asked;
        asked.grant.catch(() => {
          if (pending === asked) pending = undefined;
        });
      }
      return pending.grant;
    },
    refused(grant) {
      if (kept?.token !== grant) return false;
      const reused = kept.uses > 0;
      kept = undefined;
      return reused;
    },
    clear() {
      kept = undefined;
      pending = undefined;
    },
  };
}
