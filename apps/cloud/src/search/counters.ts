import type { Counter } from "./limits.ts";

const rows = (counters: Counter[]) => counters.map(() => "(?, ?, ?, ?)").join(", ");
const params = (counters: Counter[]) =>
  counters.flatMap((counter) => [
    counter.scope,
    counter.period.name,
    counter.period.ends,
    counter.cap,
  ]);
const countOf = (found: { scope: string; period: string; count: number }[], counter: Counter) =>
  found.find((row) => row.scope === counter.scope && row.period === counter.period.name)?.count ??
  0;

/**
 * ace search's counters in D1 (`search_counts`, ADR 0210 §4). Counts only, keyed by scope and
 * period: never a query or a result.
 *
 * A search takes all its counters in one statement, which adds one to every counter only when
 * none of them is at its cap, and otherwise writes nothing. One statement is one transaction,
 * so concurrent searches never overshoot a cap, a refused search never holds another's
 * counter, and a Worker cut short mid-request strands nothing.
 */
export function searchCounters(db: D1Database) {
  async function read(counters: Counter[]): Promise<number[]> {
    const { results } = await db
      .prepare(
        `WITH wanted(scope, period, until, cap) AS (VALUES ${rows(counters)})
         SELECT c.scope, c.period, c.count FROM wanted w
         JOIN search_counts c ON c.scope = w.scope AND c.period = w.period`,
      )
      .bind(...params(counters))
      .all<{ scope: string; period: string; count: number }>();
    return counters.map((counter) => countOf(results, counter));
  }

  return {
    /**
     * Takes one from every counter and answers their new counts, or takes none. A refusal names
     * the first counter, in the order given, that was full when read just after; `undefined` when
     * none still was (another search gave one back meanwhile).
     */
    async take(
      counters: Counter[],
    ): Promise<{ taken: true; counts: number[] } | { taken: false; full: Counter | undefined }> {
      const { results } = await db
        .prepare(
          `WITH wanted(scope, period, until, cap) AS (VALUES ${rows(counters)})
           INSERT INTO search_counts (scope, period, count, until)
           SELECT scope, period, 1, until FROM wanted
           WHERE NOT EXISTS (
             SELECT 1 FROM wanted w
             LEFT JOIN search_counts c ON c.scope = w.scope AND c.period = w.period
             WHERE COALESCE(c.count, 0) >= w.cap
           )
           ON CONFLICT (scope, period) DO UPDATE SET count = count + 1
           RETURNING scope, period, count`,
        )
        .bind(...params(counters))
        .all<{ scope: string; period: string; count: number }>();
      if (results.length > 0)
        return { taken: true, counts: counters.map((counter) => countOf(results, counter)) };
      const now = await read(counters);
      return { taken: false, full: counters.find((counter, i) => (now[i] ?? 0) >= counter.cap) };
    },
    /** Gives back one from every counter, in one statement: for a call never sent. */
    async giveBack(counters: Counter[]): Promise<void> {
      if (counters.length === 0) return;
      await db
        .prepare(
          `UPDATE search_counts SET count = count - 1
           WHERE count > 0 AND (scope, period) IN (VALUES ${counters.map(() => "(?, ?)").join(", ")})`,
        )
        .bind(...counters.flatMap((counter) => [counter.scope, counter.period.name]))
        .run();
    },
    read,
    /** Drops periods that ended before `now`, a bounded batch at a time (ADR 0170). */
    async sweep(now: number, batch = 500): Promise<void> {
      for (let round = 0; round < 20; round++) {
        const { meta } = await db
          .prepare(
            "DELETE FROM search_counts WHERE rowid IN (SELECT rowid FROM search_counts WHERE until <= ? LIMIT ?)",
          )
          .bind(now, batch)
          .run();
        if ((meta.changes ?? 0) < batch) return;
      }
    },
    /** When the account's first machine registered (its age, ADR 0210 §4), if any did. */
    async firstSeen(accountId: string): Promise<number | undefined> {
      const row = await db
        .prepare("SELECT MIN(created_at) AS first FROM machines WHERE account_id = ?")
        .bind(accountId)
        .first<{ first: number | null }>();
      return row?.first ?? undefined;
    },
    /**
     * Whether `hostId` is a live personal machine of the account (ADR 0210 §3): it holds a
     * machine credential (ADR 0190) that hasn't expired or been revoked, on a session that is
     * still signed in, of an account with no deletion recorded. Read on every search, so a
     * revocation stops the machine's grants at once.
     */
    async machineLive(accountId: string, hostId: string, now: number): Promise<boolean> {
      const row = await db
        .prepare(
          `SELECT 1 AS live FROM machine_credentials c
           JOIN sessions s ON s.token = c.session
           WHERE c.host_id = ?1 AND c.account_id = ?2 AND c.kind = 'session' AND c.expires > ?3
             AND s.expires > ?3 AND s.retired = 0 AND json_extract(s.account, '$.id') = ?2
             AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id = ?2)
           LIMIT 1`,
        )
        .bind(hostId, accountId, now)
        .first<{ live: number }>();
      return row !== null;
    },
  };
}
export type SearchCounters = ReturnType<typeof searchCounters>;
