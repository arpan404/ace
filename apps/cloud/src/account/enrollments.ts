import { notDeleted } from "./tombstone.ts";
import { z } from "zod";

const Row = z.object({ session: z.string(), host_id: z.string(), account_id: z.string() });

/** How long an enrollment ticket can be redeemed. */
export const ENROLLMENT_LIFETIME_MS = 10 * 60_000;

/**
 * Enrollment tickets (ADR 0190): what the app hands its daemon instead of its session. Keyed by
 * the ticket's digest; single use: redeeming it is a statement in the same batch that issues the
 * machine credential.
 */
export function enrollmentStore(db: D1Database) {
  return {
    async put(
      hash: string,
      ticket: { session: string; hostId: string; accountId: string; expiresAt: number },
    ) {
      await db
        .prepare(
          `INSERT INTO machine_enrollments (ticket, session, host_id, account_id, expires) SELECT ?, ?, ?, ?, ? WHERE ${notDeleted()}`,
        )
        .bind(
          hash,
          ticket.session,
          ticket.hostId,
          ticket.accountId,
          ticket.expiresAt,
          ticket.accountId,
        )
        .run();
    },
    async get(hash: string, now: number) {
      const raw = await db
        .prepare(
          "SELECT session, host_id, account_id FROM machine_enrollments WHERE ticket = ? AND expires > ?",
        )
        .bind(hash, now)
        .first();
      if (!raw) return undefined;
      const row = Row.parse(raw);
      return { session: row.session, hostId: row.host_id, accountId: row.account_id };
    },
    /** The statement that spends a ticket, for the batch that issues its credential. */
    spending: (hash: string) =>
      db.prepare("DELETE FROM machine_enrollments WHERE ticket = ?").bind(hash),
    async sweep(now: number) {
      await db.prepare("DELETE FROM machine_enrollments WHERE expires <= ?").bind(now).run();
    },
  };
}
export type EnrollmentStore = ReturnType<typeof enrollmentStore>;
