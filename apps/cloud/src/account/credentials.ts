import { z } from "zod";

const Row = z.object({
  session: z.string(),
  host_id: z.string(),
  account_id: z.string(),
  expires: z.number(),
  sole: z.number(),
  kind: z.string(),
  org_id: z.string().nullable(),
  org_name: z.string().nullable(),
  held: z.number(),
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
 * How long an organization credential lasts unrenewed (ADR 0206 §2.1), as a session does: a host
 * that stays off the backend this long is enrolled again.
 */
export const ORG_CREDENTIAL_LIFETIME_MS = 30 * 24 * 60 * 60_000;

/** The principal an organization credential names, never a person's account id. */
export const orgPrincipal = (org: string) => `org:${org}`;

/**
 * A stored credential as read: one living on a session (ADR 0190), or an org host's own
 * organization credential (ADR 0206 §2.1). `held`: the organization still holds the host under
 * the enrollment the org credential is bound to.
 */
export type ReadMachineCredential =
  | ({ kind: "session" } & StoredMachineCredential)
  | {
      kind: "org";
      hostId: string;
      org: string;
      orgName: string;
      expiresAt: number;
      held: boolean;
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
     * retry of one that worked changes nothing. On an org host, a credential for the account the
     * machine is signed in to is bound to its current enrollment (ADR 0206 §2.1); one for any
     * other account is bound to none.
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
           FROM (SELECT 1) LEFT JOIN org_hosts h ON h.host_id = ?3
             AND ?4 = (SELECT account_id FROM machines WHERE host_id = ?3)
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
    async get(hash: string, now: number): Promise<ReadMachineCredential | undefined> {
      const raw = await db
        .prepare(
          `SELECT c.session, c.host_id, c.account_id, c.expires, c.sole, c.kind, c.org_id,
             o.name AS org_name, h.host_id IS NOT NULL AS held
           FROM machine_credentials c
           LEFT JOIN org_hosts h ON h.host_id = c.host_id AND h.org_id = c.org_id AND h.enrollment = c.enrollment
           LEFT JOIN orgs o ON o.org_id = c.org_id
           WHERE c.token = ? AND c.expires > ?`,
        )
        .bind(hash, now)
        .first();
      if (!raw) return undefined;
      const row = Row.parse(raw);
      // An unknown kind from a later build is read as an org credential that holds nothing.
      if (row.kind !== "session")
        return {
          kind: "org",
          hostId: row.host_id,
          org: row.org_id ?? "",
          orgName: row.org_name ?? "",
          expiresAt: row.expires,
          held: row.kind === "org" && row.held === 1 && row.org_id !== null,
        };
      return {
        kind: "session",
        session: row.session,
        hostId: row.host_id,
        accountId: row.account_id,
        expiresAt: row.expires,
        sole: row.sole === 1,
      };
    },
    /**
     * Issues an org host its organization credential (ADR 0206 §2.1), bound to the host's
     * current enrollment in `org`: at most one per enrollment, so a second request with another
     * credential issues nothing. No session is behind it. True when this request issued it.
     */
    async issueOrg(
      hash: string,
      credential: { hostId: string; org: string; expiresAt: number },
      now: number,
    ): Promise<boolean> {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO machine_credentials (token, session, host_id, account_id, expires, sole, created_at, org_id, enrollment, kind)
           SELECT ?1, '', h.host_id, ?4, ?5, 0, ?6, h.org_id, h.enrollment, 'org'
           FROM org_hosts h WHERE h.host_id = ?2 AND h.org_id = ?3 AND h.enrollment IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM machine_credentials c
               WHERE c.host_id = h.host_id AND c.kind = 'org' AND c.enrollment = h.enrollment)`,
        )
        .bind(
          hash,
          credential.hostId,
          credential.org,
          orgPrincipal(credential.org),
          credential.expiresAt,
          now,
        )
        .run();
      return result.meta.changes > 0;
    },
    /**
     * Renews an organization credential to `expires`, only while `org` still holds its host under
     * the enrollment it was issued for. True when it did.
     */
    async renewOrg(hash: string, hostId: string, org: string, expires: number): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE machine_credentials SET expires = MAX(expires, ?4)
           WHERE token = ?1 AND kind = 'org' AND host_id = ?2 AND org_id = ?3
             AND enrollment = (SELECT enrollment FROM org_hosts WHERE host_id = ?2 AND org_id = ?3)`,
        )
        .bind(hash, hostId, org, expires)
        .run();
      return result.meta.changes > 0;
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
