import type { Counter } from "./limits.ts";

const rows = (counters: Counter[]) =>
  counters.map((_, i) => `(?${4 * i + 1}, ?${4 * i + 2}, ?${4 * i + 3}, ?${4 * i + 4})`).join(", ");
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
 * Whether machine `host` is a live personal machine of `account` at `now` (ADR 0210 §3), with
 * the principal reader's own rules for a machine credential (principal.ts, credentials.ts,
 * sessions.ts): the credential is a session credential that hasn't expired, and the session it
 * lives on hasn't expired, names the same account, and has no deletion recorded. The session may
 * be retired: `ace login` retires its token when the credential becomes its sole holder, and the
 * credential still speaks for it. The arguments are parameter numbers.
 */
const liveMachine = (account: number, host: number, now: number) =>
  `EXISTS (SELECT 1 FROM machine_credentials mc
     JOIN sessions ms ON ms.token = mc.session
     WHERE mc.host_id = ?${host} AND mc.account_id = ?${account} AND mc.kind = 'session'
       AND mc.expires > ?${now} AND ms.expires > ?${now}
       AND json_extract(ms.account, '$.id') = ?${account}
       AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id = ?${account}))`;

/** The machine a search is for: the account, the grant's subject, and the time it asks. */
export type Holder = { account: string; machine: string; now: number };

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

  /** Whether `hostId` is a live personal machine of the account now (see `liveMachine`). */
  async function machineLive(accountId: string, hostId: string, now: number): Promise<boolean> {
    const row = await db
      .prepare(`SELECT ${liveMachine(1, 2, 3)} AS live`)
      .bind(accountId, hostId, now)
      .first<{ live: number }>();
    return row?.live === 1;
  }

  return {
    /**
     * Takes one from every counter and answers their new counts, or takes none. A refusal names
     * the first counter, in the order given, that was full when read just after; `undefined` when
     * none still was (another search gave one back meanwhile).
     */
    async take(
      counters: Counter[],
      holder: Holder,
    ): Promise<
      | { taken: true; counts: number[] }
      | { taken: false; machineGone: true }
      | { taken: false; machineGone: false; full: Counter | undefined }
    > {
      const base = counters.length * 4;
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
           AND ${liveMachine(base + 1, base + 2, base + 3)}
           ON CONFLICT (scope, period) DO UPDATE SET count = count + 1
           RETURNING scope, period, count`,
        )
        .bind(...params(counters), holder.account, holder.machine, holder.now)
        .all<{ scope: string; period: string; count: number }>();
      if (results.length > 0)
        return { taken: true, counts: counters.map((counter) => countOf(results, counter)) };
      if (!(await machineLive(holder.account, holder.machine, holder.now)))
        return { taken: false, machineGone: true };
      const now = await read(counters);
      return {
        taken: false,
        machineGone: false,
        full: counters.find((counter, i) => (now[i] ?? 0) >= counter.cap),
      };
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
    machineLive,
  };
}
export type SearchCounters = ReturnType<typeof searchCounters>;
