/** A device grant as the account backend returns it: the token and when it runs out. */
export interface FetchedGrant {
  token: string;
  /** Epoch milliseconds, on the backend's clock. */
  expiresAt: number;
  /** The standing grant the backend gave with it (ADR 0189), for the hello. */
  standing?: string | undefined;
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
  /**
   * The grant for `session`: the kept one while it may still be used, else a fresh one.
   * `machine` names the machine asking (its host id), so a refusal can tell how that machine
   * got its grant.
   */
  grant(session: string, machine?: string): Promise<string>;
  /**
   * The daemon or the relay refused `grant`, presented by `machine`. If it is still the kept
   * one, it is never offered again; any other grant (one already replaced, another machine's
   * newer one) stays. True when `machine` had it from the cache, so a fresh grant is worth one
   * more try, however many machines shared it and in whatever order their refusals come; false
   * for a grant fetched fresh for that machine's attempt, which a fresh one would not change.
   */
  refused(grant: string, machine?: string): boolean;
  /** The standing grant that came with `grant` (ADR 0189), while it is one of the latest. */
  standing(grant: string): string | undefined;
  /**
   * `machine` no longer needs to know how it got its grant: its connection was welcomed, or the
   * machine was closed or removed. Its record goes, so records never outlive their use.
   */
  settled(machine: string): void;
  /** Sign-out: forget every grant, and every record of how one was given. */
  clear(): void;
}

/**
 * Device grants for one window, in memory only (ADR 0114, ADR 0150): a connect, every path of
 * its race and a reconnect soon after share one grant instead of each asking the account
 * backend; concurrent asks share one fetch. A grant is kept for one ace session only: another
 * session (an account switch) or a sign-out forgets it. It is reused only while it is young by
 * both clocks: `elapsed`, which only moves forward (`performance.now`) but stands still while
 * the laptop sleeps, and `wall`, which keeps counting through sleep but can be set back. Never
 * past the five minutes any grant lives. The daemon's or the relay's refusal is the authority:
 * a refused grant is dropped at once.
 */
export function grantCache(
  fetch: (session: string) => Promise<FetchedGrant>,
  clocks: { wall(): number; elapsed(): number },
): GrantCache {
  let kept:
    | { session: string; token: string; at: number; wallAt: number; reuseMs: number }
    | undefined;
  let pending: { session: string; grant: Promise<string> } | undefined;
  /**
   * The last grant each machine was given, and whether it came from the cache: kept only from
   * handing it out until its fate is known, and for one ace session only.
   */
  const served = new Map<string, { token: string; cached: boolean }>();
  /** The latest grants' standing grants, by grant: a hello built from one finds its own. */
  const standings = new Map<string, string>();
  let servedSession: string | undefined;
  /** Records belong to one session: another (an account switch) starts with none. */
  const record = (session: string, machine: string, token: string, cached: boolean) => {
    if (servedSession !== session) served.clear();
    servedSession = session;
    served.set(machine, { token, cached });
  };
  /** Whether the kept grant is young enough to offer again, by both clocks. */
  const fresh = (grant: NonNullable<typeof kept>) =>
    clocks.elapsed() - grant.at < grant.reuseMs && clocks.wall() - grant.wallAt < grant.reuseMs;
  return {
    async grant(session, machine = "") {
      if (kept && kept.session !== session) kept = undefined;
      if (kept && fresh(kept)) {
        record(session, machine, kept.token, true);
        return kept.token;
      }
      kept = undefined;
      if (pending?.session !== session) {
        const at = clocks.elapsed();
        const wallAt = clocks.wall();
        const asked = {
          session,
          grant: fetch(session).then((grant) => {
            // Its life from now: what the backend says, as the wall clock reads it, but never
            // past the most any grant lives.
            const life = Math.min(grant.expiresAt - wallAt, grantLifetimeCapMs);
            if (pending === asked) pending = undefined;
            kept = { session, token: grant.token, at, wallAt, reuseMs: life - grantReuseMarginMs };
            if (grant.standing !== undefined) {
              standings.set(grant.token, grant.standing);
              for (const old of standings.keys()) if (standings.size > 4) standings.delete(old);
            }
            return grant.token;
          }),
        };
        pending = asked;
        asked.grant.catch(() => {
          if (pending === asked) pending = undefined;
        });
      }
      // Fetched for this attempt (or one sharing its fetch): not from the cache.
      const token = await pending.grant;
      record(session, machine, token, false);
      return token;
    },
    refused(grant, machine = "") {
      if (kept?.token === grant) kept = undefined;
      const given = served.get(machine);
      if (given?.token !== grant) return false;
      served.delete(machine);
      return given.cached;
    },
    standing(grant) {
      return standings.get(grant);
    },
    settled(machine) {
      served.delete(machine);
    },
    clear() {
      kept = undefined;
      standings.clear();
      pending = undefined;
      served.clear();
      servedSession = undefined;
    },
  };
}
