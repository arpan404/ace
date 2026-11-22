import type { Counter } from "./limits.ts";

/**
 * ace search's counters in D1 (`search_counts`, ADR 0210 §4). Counts only, keyed by scope and
 * period: never a query or a result.
 *
 * A search takes all its counters in one batch. Each statement adds one only while its counter
 * is under its cap, in a single upsert, so concurrent searches can never take a counter past
 * its cap. When any counter was full, the ones taken are given back.
 */
export function searchCounters(db: D1Database) {
  const take = (counter: Counter) =>
    db
      .prepare(
        `INSERT INTO search_counts (scope, period, count, until)
         SELECT ?1, ?2, 1, ?3 WHERE ?4 > 0
         ON CONFLICT (scope, period) DO UPDATE SET count = count + 1 WHERE count < ?4
         RETURNING count`,
      )
      .bind(counter.scope, counter.period.name, counter.period.ends, counter.cap);
  const giveBack = (counter: Counter) =>
    db
      .prepare(
        "UPDATE search_counts SET count = count - 1 WHERE scope = ? AND period = ? AND count > 0",
      )
      .bind(counter.scope, counter.period.name);

  return {
    /**
     * Takes one from every counter, answering each one's new count; or takes none, answering the
     * first full counter in the order given.
     */
    async take(counters: Counter[]): Promise<{ full?: Counter; counts?: number[] }> {
      const results = await db.batch<{ count: number }>(counters.map(take));
      const taken = counters.filter((_, index) => (results[index]?.results.length ?? 0) > 0);
      const full = counters.find((_, index) => (results[index]?.results.length ?? 0) === 0);
      if (!full)
        return { counts: counters.map((_, index) => results[index]?.results[0]?.count ?? 0) };
      if (taken.length > 0) await db.batch(taken.map(giveBack));
      return { full };
    },
    /** Gives back every counter a search took, for a search that never ran. */
    async giveBack(counters: Counter[]): Promise<void> {
      if (counters.length > 0) await db.batch(counters.map(giveBack));
    },
    /** How many each counter holds now. */
    async read(counters: Counter[]): Promise<number[]> {
      const results = await db.batch<{ count: number }>(
        counters.map((counter) =>
          db
            .prepare("SELECT count FROM search_counts WHERE scope = ? AND period = ?")
            .bind(counter.scope, counter.period.name),
        ),
      );
      return counters.map((_, index) => results[index]?.results[0]?.count ?? 0);
    },
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
  };
}
export type SearchCounters = ReturnType<typeof searchCounters>;
