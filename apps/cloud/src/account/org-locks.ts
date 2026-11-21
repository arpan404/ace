/**
 * Short named leases in D1 (`org_locks`, migration 0007) that serialize work across isolates:
 * an organization's membership changes, an admin's Admin Portal links against their revocation.
 * A lease runs out after `ms`, so one a crashed request held never blocks for long, and only its
 * holder gives it back.
 */
export function orgLocks(
  db: D1Database,
  deps: {
    now: () => number;
    /** Names each holder. */
    newHolder: () => string;
    sleep: (ms: number) => Promise<void>;
  },
) {
  async function take(name: string, ms: number): Promise<string | undefined> {
    const holder = deps.newHolder();
    const now = deps.now();
    const result = await db
      .prepare(
        `INSERT INTO org_locks (name, holder, until) VALUES (?1, ?2, ?3)
         ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, until = excluded.until
         WHERE org_locks.until <= ?4`,
      )
      .bind(name, holder, now + ms, now)
      .run();
    return result.meta.changes > 0 ? holder : undefined;
  }
  async function give(name: string, holder: string) {
    await db
      .prepare("DELETE FROM org_locks WHERE name = ? AND holder = ?")
      .bind(name, holder)
      .run();
  }

  return {
    /**
     * Runs `then` holding `name`, waiting up to `tries` turns of `waitMs` for it; `busy` when
     * another holder kept it all that time.
     */
    async holding<T>(
      name: string,
      lease: { ms: number; tries: number; waitMs: number },
      then: () => Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false }> {
      for (let attempt = 0; attempt < lease.tries; attempt++) {
        if (attempt > 0) await deps.sleep(lease.waitMs);
        const holder = await take(name, lease.ms);
        if (!holder) continue;
        try {
          return { ok: true, value: await then() };
        } finally {
          await give(name, holder);
        }
      }
      return { ok: false };
    },
  };
}
export type OrgLocks = ReturnType<typeof orgLocks>;
