import { z } from "zod";

const Row = z.object({
  session: z.string(),
  host_id: z.string(),
  account_id: z.string(),
  expires: z.number(),
  sole: z.number(),
});

export type StoredMachineCredential = {
  /** The digest of the session it was exchanged from. */
  session: string;
  hostId: string;
  accountId: string;
  expiresAt: number;
  sole: boolean;
};

/**
 * Machine credentials in D1 (ADR 0190), keyed by the credential's digest. A credential holds no
 * WorkOS token of its own: it lives on the session it was exchanged from.
 */
export function machineCredentialStore(db: D1Database) {
  return {
    /**
     * The statement that issues a credential, for the batch with the session's change (ADR 0190),
     * only while `from` can still issue it: a session whose token isn't retired, or an unspent
     * ticket. Two exchanges racing for one session or ticket issue at most one credential, and a
     * retry of one that worked changes nothing. On an org host, a credential of the account that
     * enrolled it is bound to that enrollment (ADR 0206 §2.1); anyone else's is bound to none.
     */
    inserting(
      hash: string,
      credential: StoredMachineCredential,
      now: number,
      from: { session: string } | { ticket: string },
    ) {
      const guard =
        "session" in from
          ? "SELECT 1 FROM sessions WHERE token = ?8 AND retired = 0 AND expires > ?7"
          : "SELECT 1 FROM machine_enrollments WHERE ticket = ?8 AND expires > ?7";
      return db
        .prepare(
          `INSERT OR IGNORE INTO machine_credentials (token, session, host_id, account_id, expires, sole, created_at, org_id, enrollment)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, h.org_id, h.enrollment
           FROM (SELECT 1) LEFT JOIN org_hosts h ON h.host_id = ?3 AND h.enrolled_by = ?4
           WHERE EXISTS (${guard})`,
        )
        .bind(
          hash,
          credential.session,
          credential.hostId,
          credential.accountId,
          credential.expiresAt,
          credential.sole ? 1 : 0,
          now,
          "session" in from ? from.session : from.ticket,
        );
    },
    async get(hash: string, now: number): Promise<StoredMachineCredential | undefined> {
      const raw = await db
        .prepare(
          "SELECT session, host_id, account_id, expires, sole FROM machine_credentials WHERE token = ? AND expires > ?",
        )
        .bind(hash, now)
        .first();
      if (!raw) return undefined;
      const row = Row.parse(raw);
      return {
        session: row.session,
        hostId: row.host_id,
        accountId: row.account_id,
        expiresAt: row.expires,
        sole: row.sole === 1,
      };
    },
    /** Keeps the credential as long as its session, which each read renews. */
    async renew(hash: string, expires: number) {
      await db
        .prepare("UPDATE machine_credentials SET expires = ? WHERE token = ? AND expires < ?")
        .bind(expires, hash, expires)
        .run();
    },
    /** Removes a credential, and the session it was exchanged from when it was that one's only holder. */
    async remove(hash: string) {
      await db.batch([
        db
          .prepare(
            "DELETE FROM sessions WHERE token = (SELECT session FROM machine_credentials WHERE token = ? AND sole = 1)",
          )
          .bind(hash),
        db.prepare("DELETE FROM machine_credentials WHERE token = ?").bind(hash),
      ]);
    },
    async sweep(now: number) {
      await db.prepare("DELETE FROM machine_credentials WHERE expires <= ?").bind(now).run();
    },
  };
}
export type MachineCredentialStore = ReturnType<typeof machineCredentialStore>;
