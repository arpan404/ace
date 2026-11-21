import { z } from "zod";
import type { AceMachine } from "@ace/protocol/ace-account";
import type { AceOrgMember, AceOrgSpace } from "@ace/protocol/ace-org";

/**
 * The organization tables in D1 (migration 0005, ADR 0206). The members mirror only lists and
 * refuses faster; `org_checks` holds WorkOS's own recent answers, which decide every grant.
 *
 * Mirror rows carry the WorkOS time of the state they hold (`version`, ISO 8601, which sorts as
 * text): an event older than a row's state changes nothing, so the feed can be replayed.
 */

/** How long WorkOS's answer on a session's membership is reused (ADR 0206 §1.4). */
export const ORG_CHECK_TTL_MS = 60_000;

const MemberRow = z.object({
  org_id: z.string(),
  account_id: z.string(),
  membership_id: z.string(),
  role: z.string(),
  status: z.string(),
  directory_managed: z.number(),
  email: z.string().nullable(),
  name: z.string().nullable(),
});
export type MemberRow = z.infer<typeof MemberRow>;
const memberStatus = (status: string): AceOrgMember["status"] =>
  status === "active" || status === "pending" || status === "inactive" ? status : "removed";
const SpaceRow = z.object({
  org_id: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  plan: z.string().nullable(),
  directory_managed: z.number(),
  no_owner: z.number().nullable(),
});
const MachineRow = z.object({
  host_id: z.string(),
  name: z.string(),
  platform: z.string(),
  last_seen_at: z.number(),
});
const CheckRow = z.object({ role: z.string(), sid: z.string(), checked_at: z.number() });
const PolicyRow = z.object({
  version: z.number(),
  body: z.string(),
  statement: z.string(),
  set_by: z.string(),
  set_at: z.number(),
});

/** One membership as WorkOS last described it. */
export type MirroredMember = {
  org: string;
  account: string;
  membership: string;
  role: string;
  status: string;
  directoryManaged: boolean;
  email?: string | undefined;
  name?: string | undefined;
  version: string;
};

export function orgStore(db: D1Database) {
  const upsertingMember = (member: MirroredMember, now: number) =>
    db
      .prepare(
        `INSERT INTO org_members (org_id, account_id, membership_id, role, status, directory_managed, email, name, version, joined_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (org_id, account_id) DO UPDATE SET
           membership_id = excluded.membership_id, role = excluded.role, status = excluded.status,
           directory_managed = excluded.directory_managed,
           email = COALESCE(excluded.email, org_members.email),
           name = COALESCE(excluded.name, org_members.name),
           version = excluded.version
         WHERE excluded.version >= org_members.version`,
      )
      .bind(
        member.org,
        member.account,
        member.membership,
        member.role,
        member.status,
        member.directoryManaged ? 1 : 0,
        member.email ?? null,
        member.name ?? null,
        member.version,
        now,
      );
  return {
    upsertingOrg: (
      org: { id: string; name: string; createdBy?: string; version: string },
      now: number,
    ) =>
      db
        .prepare(
          `INSERT INTO orgs (org_id, name, created_by, created_at, version) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (org_id) DO UPDATE SET name = excluded.name, deleted = 0, version = excluded.version
           WHERE excluded.version >= orgs.version`,
        )
        .bind(org.id, org.name, org.createdBy ?? "", now, org.version),
    deletingOrg: (org: string, version: string) =>
      db
        .prepare("UPDATE orgs SET deleted = 1, version = ?2 WHERE org_id = ?1 AND version <= ?2")
        .bind(org, version),
    upsertingMember,
    /** Marks one membership deleted, kept as `removed` for history (ADR 0206 §6). */
    removingMember: (org: string, account: string, membership: string, version: string) =>
      db
        .prepare(
          "UPDATE org_members SET status = 'removed', version = ?4 WHERE org_id = ?1 AND account_id = ?2 AND membership_id = ?3 AND version <= ?4",
        )
        .bind(org, account, membership, version),
    renamingAccount: (account: string, email: string, name: string) =>
      db
        .prepare("UPDATE org_members SET email = ?2, name = ?3 WHERE account_id = ?1")
        .bind(account, email, name),
    /** Flags an organization the directory left with no active owner, or clears the flag. */
    flaggingOwners: (org: string) =>
      db
        .prepare(
          "UPDATE orgs SET no_owner = NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = ?1 AND role = 'owner' AND status = 'active') WHERE org_id = ?1",
        )
        .bind(org),
    async run(statements: D1PreparedStatement[]) {
      if (statements.length > 0) await db.batch(statements);
    },

    async member(org: string, account: string): Promise<MemberRow | undefined> {
      const raw = await db
        .prepare(
          "SELECT org_id, account_id, membership_id, role, status, directory_managed, email, name FROM org_members WHERE org_id = ? AND account_id = ?",
        )
        .bind(org, account)
        .first();
      return raw ? MemberRow.parse(raw) : undefined;
    },
    async activeOwners(org: string): Promise<number> {
      const raw = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner' AND status = 'active'",
        )
        .bind(org)
        .first<{ n: number }>();
      return raw?.n ?? 0;
    },
    /** The account's spaces: every organization it is an active member of. */
    async spaces(account: string): Promise<AceOrgSpace[]> {
      const { results } = await db
        .prepare(
          `SELECT m.org_id, o.name, m.role, o.plan, m.directory_managed, o.no_owner
           FROM org_members m LEFT JOIN orgs o ON o.org_id = m.org_id
           WHERE m.account_id = ? AND m.status = 'active' AND COALESCE(o.deleted, 0) = 0
           ORDER BY o.name LIMIT 1000`,
        )
        .bind(account)
        .all();
      return results.map((raw) => {
        const row = SpaceRow.parse(raw);
        const space: AceOrgSpace = {
          id: row.org_id,
          name: row.name ?? "",
          role: row.role,
          plan: row.plan === "team" ? "team" : "pilot",
          directoryManaged: row.directory_managed === 1,
        };
        if (row.no_owner === 1) space.noOwner = true;
        return space;
      });
    },
    async members(org: string): Promise<AceOrgMember[]> {
      const { results } = await db
        .prepare(
          "SELECT org_id, account_id, membership_id, role, status, directory_managed, email, name FROM org_members WHERE org_id = ? AND status != 'removed' ORDER BY name, email LIMIT 10000",
        )
        .bind(org)
        .all();
      return results.map((raw) => {
        const row = MemberRow.parse(raw);
        const member: AceOrgMember = {
          account: row.account_id,
          role: row.role,
          status: memberStatus(row.status),
          directoryManaged: row.directory_managed === 1,
        };
        if (row.email) member.email = row.email;
        if (row.name) member.name = row.name;
        return member;
      });
    },
    async orgName(org: string): Promise<string | undefined> {
      const raw = await db
        .prepare("SELECT name FROM orgs WHERE org_id = ? AND deleted = 0")
        .bind(org)
        .first<{ name: string }>();
      return raw?.name;
    },

    /** WorkOS's answer for this session and organization, if it is under 60 seconds old. */
    async check(session: string, org: string, now: number) {
      const raw = await db
        .prepare("SELECT role, sid, checked_at FROM org_checks WHERE session = ? AND org_id = ?")
        .bind(session, org)
        .first();
      if (!raw) return undefined;
      const row = CheckRow.parse(raw);
      return now - row.checked_at < ORG_CHECK_TTL_MS && row.checked_at <= now ? row : undefined;
    },
    async putCheck(
      check: { session: string; org: string; account: string; role: string; sid: string },
      now: number,
    ) {
      await db
        .prepare(
          `INSERT INTO org_checks (session, org_id, account_id, role, sid, checked_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (session, org_id) DO UPDATE SET account_id = excluded.account_id, role = excluded.role, sid = excluded.sid, checked_at = excluded.checked_at`,
        )
        .bind(check.session, check.org, check.account, check.role, check.sid, now)
        .run();
    },
    async dropCheck(session: string, org: string) {
      await db
        .prepare("DELETE FROM org_checks WHERE session = ? AND org_id = ?")
        .bind(session, org)
        .run();
    },
    /** Every recent answer for this account and organization, once its membership changed. */
    droppingChecks: (org: string, account: string) =>
      db.prepare("DELETE FROM org_checks WHERE org_id = ? AND account_id = ?").bind(org, account),

    async hostOrg(hostId: string): Promise<string | undefined> {
      const raw = await db
        .prepare("SELECT org_id FROM org_hosts WHERE host_id = ?")
        .bind(hostId)
        .first<{ org_id: string }>();
      return raw?.org_id;
    },
    /**
     * Spends a machine's consent to join `org` (ADR 0206 §2.1): true the first time its nonce is
     * seen, false for every replay.
     */
    async spendConsent(consent: {
      nonce: string;
      hostId: string;
      org: string;
      expiresAt: number;
    }): Promise<boolean> {
      const spent = await db
        .prepare(
          "INSERT OR IGNORE INTO org_enroll_consents (nonce, host_id, org_id, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind(consent.nonce, consent.hostId, consent.org, consent.expiresAt)
        .run();
      return (spent.meta.changes ?? 0) > 0;
    },
    /**
     * Gives a machine to an organization: its directory row and machine credentials name the
     * org, in one batch. Only a machine the directory knows, not yet any org's, moves; who may
     * give it is the machine's own consent's to say (`spendConsent`), never the directory row's
     * account, which can differ from the machine's owner (ADR 0190 §3a).
     */
    async enrollHost(
      host: { hostId: string; org: string; account: string; auditKey?: string | undefined },
      now: number,
    ): Promise<boolean> {
      const [inserted] = await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO org_hosts (host_id, org_id, enrolled_by, enrolled_at, audit_key)
             SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM machines WHERE host_id = ?1 AND org_id IS NULL)`,
          )
          .bind(host.hostId, host.org, host.account, now, host.auditKey ?? null),
        db
          .prepare(
            "UPDATE machines SET org_id = ?2 WHERE host_id = ?1 AND EXISTS (SELECT 1 FROM org_hosts WHERE host_id = ?1 AND org_id = ?2)",
          )
          .bind(host.hostId, host.org),
        db
          .prepare(
            "UPDATE machine_credentials SET org_id = ?2 WHERE host_id = ?1 AND EXISTS (SELECT 1 FROM org_hosts WHERE host_id = ?1 AND org_id = ?2)",
          )
          .bind(host.hostId, host.org),
      ]);
      return (inserted?.meta.changes ?? 0) > 0;
    },
    /** Releases an org host: it is nobody's org host until the next owner's proof (ADR 0206 §2.1). */
    async releaseHost(hostId: string, org: string): Promise<boolean> {
      const [removed] = await db.batch([
        db.prepare("DELETE FROM org_hosts WHERE host_id = ? AND org_id = ?").bind(hostId, org),
        db
          .prepare("UPDATE machines SET org_id = NULL WHERE host_id = ? AND org_id = ?")
          .bind(hostId, org),
        db
          .prepare("UPDATE machine_credentials SET org_id = NULL WHERE host_id = ? AND org_id = ?")
          .bind(hostId, org),
      ]);
      return (removed?.meta.changes ?? 0) > 0;
    },
    async hosts(org: string): Promise<AceMachine[]> {
      const { results } = await db
        .prepare(
          `SELECT h.host_id, COALESCE(m.name, '') AS name, COALESCE(m.platform, '') AS platform,
             COALESCE(m.last_seen_at, h.enrolled_at) AS last_seen_at
           FROM org_hosts h LEFT JOIN machines m ON m.host_id = h.host_id
           WHERE h.org_id = ? ORDER BY last_seen_at DESC LIMIT 1000`,
        )
        .bind(org)
        .all();
      return results.map((raw) => {
        const row = MachineRow.parse(raw);
        return {
          hostId: row.host_id,
          name: row.name,
          platform: row.platform,
          lastSeenAt: row.last_seen_at,
        };
      });
    },
    /** The account's own machines: those no organization owns. */
    async personalMachines(account: string): Promise<AceMachine[]> {
      const { results } = await db
        .prepare(
          "SELECT host_id, name, platform, last_seen_at FROM machines WHERE account_id = ? AND org_id IS NULL ORDER BY last_seen_at DESC LIMIT 1000",
        )
        .bind(account)
        .all();
      return results.map((raw) => {
        const row = MachineRow.parse(raw);
        return {
          hostId: row.host_id,
          name: row.name,
          platform: row.platform,
          lastSeenAt: row.last_seen_at,
        };
      });
    },

    async policy(org: string) {
      const raw = await db
        .prepare(
          "SELECT version, body, statement, set_by, set_at FROM org_policies WHERE org_id = ? ORDER BY version DESC LIMIT 1",
        )
        .bind(org)
        .first();
      return raw ? PolicyRow.parse(raw) : undefined;
    },
    /** Stores a policy version; false when that version already exists (a concurrent edit). */
    async putPolicy(policy: {
      org: string;
      version: number;
      body: string;
      sha256: string;
      setBy: string;
      setAt: number;
      statement: string;
    }): Promise<boolean> {
      const result = await db
        .prepare(
          "INSERT OR IGNORE INTO org_policies (org_id, version, body, body_sha256, set_by, set_at, statement) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          policy.org,
          policy.version,
          policy.body,
          policy.sha256,
          policy.setBy,
          policy.setAt,
          policy.statement,
        )
        .run();
      return result.meta.changes > 0;
    },

    async cursor(feed: string): Promise<string | undefined> {
      const raw = await db
        .prepare("SELECT after FROM workos_events WHERE feed = ?")
        .bind(feed)
        .first<{ after: string }>();
      return raw?.after;
    },
    settingCursor: (feed: string, after: string, now: number) =>
      db
        .prepare(
          "INSERT INTO workos_events (feed, after, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (feed) DO UPDATE SET after = excluded.after, updated_at = excluded.updated_at",
        )
        .bind(feed, after, now),
    async sweep(now: number) {
      await db
        .prepare("DELETE FROM org_checks WHERE checked_at < ?")
        .bind(now - 60 * ORG_CHECK_TTL_MS)
        .run();
      await db.prepare("DELETE FROM org_enroll_consents WHERE expires_at < ?").bind(now).run();
    },
  };
}
export type OrgStore = ReturnType<typeof orgStore>;
