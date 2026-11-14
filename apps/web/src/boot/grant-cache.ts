/** A device grant as the account backend returns it: the token and when it runs out. */
export interface FetchedGrant {
  token: string;
  /** Epoch milliseconds, on the backend's clock. */
  expiresAt: number;
}

/**
 * A grant with less than this left is not offered again. It stays above the grant keeper's
 * refresh lead (60 s, `GRANT_REFRESH_LEAD_MS`), so a socket's refresh never gets back the
 * grant it is replacing, even with the browser's clock half a minute off the backend's.
 */
export const grantReuseMarginMs = 120_000;

/**
 * Device grants for one window, kept in memory for most of their five minutes (ADR 0114): a
 * connect, every path of its race and a reconnect soon after share one grant instead of each
 * asking the account backend. Concurrent asks share one fetch. A grant is kept per ace session,
 * so signing in to another account never reuses the last one's. The daemon still checks every
 * grant's expiry; a failed fetch is never kept.
 */
export function grantCache(
  fetch: (session: string) => Promise<FetchedGrant>,
  now: () => number,
): (session: string) => Promise<string> {
  let kept: { session: string; grant: FetchedGrant } | undefined;
  let pending: { session: string; grant: Promise<FetchedGrant> } | undefined;
  return async (session) => {
    if (kept?.session === session && kept.grant.expiresAt - now() > grantReuseMarginMs)
      return kept.grant.token;
    if (pending?.session !== session) {
      const asked = { session, grant: fetch(session) };
      pending = asked;
      void asked.grant.then(
        (grant) => {
          if (pending === asked) pending = undefined;
          kept = { session, grant };
        },
        () => {
          if (pending === asked) pending = undefined;
        },
      );
    }
    return (await pending.grant).token;
  };
}
