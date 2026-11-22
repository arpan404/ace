import { z } from "zod";
import { AceOrgRosterBody } from "@ace/protocol/ace-org";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { HeldRoster, Lease, RosterMember, StopReason } from "./rules.ts";

/*
 * The org host's own record of who may run work (ADR 0209 §7): the roster it holds, durable
 * revocations, each member tree's execution lease, and the offline allowance its organization's
 * policy last set. New tables, empty at open, nothing rewritten (ADR 0170). Small: one roster,
 * a row per member seen revoked, a row per member tree.
 */

const schema = [
  `CREATE TABLE IF NOT EXISTS member_roster (
    org TEXT PRIMARY KEY, version INTEGER NOT NULL, at INTEGER NOT NULL,
    received_at INTEGER NOT NULL, body TEXT NOT NULL, statement TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS member_revocations (
    org TEXT NOT NULL, account TEXT NOT NULL, version INTEGER NOT NULL, seen_at INTEGER NOT NULL,
    PRIMARY KEY (org, account))`,
  `CREATE TABLE IF NOT EXISTS member_leases (
    root_id TEXT PRIMARY KEY, org TEXT NOT NULL, account TEXT NOT NULL, held_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, ended_at INTEGER, ended_reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS member_policy (
    org TEXT PRIMARY KEY, version INTEGER NOT NULL, offline_minutes INTEGER)`,
];

const RosterRow = z.object({
  version: z.number(),
  at: z.number(),
  received_at: z.number(),
  body: z.string(),
});
const LeaseRow = z.object({ root_id: z.string(), account: z.string(), expires_at: z.number() });
const Account = z.object({ account: z.string() });
const PolicyRow = z.object({ version: z.number(), offline_minutes: z.number().nullable() });
const Ended = z.object({ ended_reason: z.enum(["revoked", "lease_expired", "stopped"]) });

/** The members of a roster body, by account. */
export function rosterMembers(body: string): Map<string, RosterMember> {
  const parsed = AceOrgRosterBody.parse(JSON.parse(body));
  return new Map(
    parsed.members.map((member) => [member.account, { status: member.status, role: member.role }]),
  );
}

export function memberWorkStore(store: { atomic<T>(run: (db: DatabaseSync) => T): T }) {
  store.atomic((db) => {
    for (const statement of schema) db.exec(statement);
  });
  const read = <T>(run: (db: DatabaseSync) => T) => store.atomic(run);

  return {
    roster(org: string): HeldRoster | undefined {
      const raw = read((db) =>
        db
          .prepare("SELECT version, at, received_at, body FROM member_roster WHERE org = ?")
          .get(org),
      );
      if (!raw) return undefined;
      const row = RosterRow.parse(raw);
      return {
        org,
        version: row.version,
        at: row.at,
        receivedAt: row.received_at,
        members: rosterMembers(row.body),
      };
    },
    /**
     * Takes a roster with what it revokes and lifts, in one transaction: a crash leaves either
     * the old roster and its revocations or the new one and all of its own.
     */
    takeRoster(
      roster: { org: string; version: number; at: number; body: string; statement: string },
      changes: { revoke: readonly string[]; clear: readonly string[] },
      now: number,
    ): string[] {
      return store.atomic((db) => {
        db.prepare(
          `INSERT INTO member_roster (org, version, at, received_at, body, statement)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (org) DO UPDATE SET version = excluded.version, at = excluded.at,
             received_at = excluded.received_at, body = excluded.body, statement = excluded.statement`,
        ).run(roster.org, roster.version, roster.at, now, roster.body, roster.statement);
        const lift = db.prepare("DELETE FROM member_revocations WHERE org = ? AND account = ?");
        for (const account of changes.clear) lift.run(roster.org, account);
        const fresh: string[] = [];
        const revoke = db.prepare(
          `INSERT INTO member_revocations (org, account, version, seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (org, account) DO NOTHING`,
        );
        for (const account of changes.revoke)
          if (Number(revoke.run(roster.org, account, roster.version, now).changes) > 0)
            fresh.push(account);
        return fresh;
      });
    },
    revoked(org: string, account: string): boolean {
      return (
        read((db) =>
          db
            .prepare("SELECT 1 AS one FROM member_revocations WHERE org = ? AND account = ?")
            .get(org, account),
        ) !== undefined
      );
    },
    revokedAccounts(org: string): string[] {
      return read((db) =>
        db.prepare("SELECT account FROM member_revocations WHERE org = ?").all(org),
      ).map((raw) => Account.parse(raw).account);
    },
    /** A member tree's lease, held or taken again; a stopped tree resumes with a fresh one. */
    hold(org: string, account: string, root: string, now: number, expiresAt: number) {
      store.atomic((db) =>
        db
          .prepare(
            `INSERT INTO member_leases (root_id, org, account, held_at, expires_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (root_id) DO UPDATE SET org = excluded.org, account = excluded.account,
               held_at = excluded.held_at, expires_at = excluded.expires_at, ended_at = NULL,
               ended_reason = NULL`,
          )
          .run(root, org, account, now, expiresAt),
      );
    },
    /** The tree finished on its own: its lease goes, with nothing to say. */
    release(root: string) {
      store.atomic((db) => db.prepare("DELETE FROM member_leases WHERE root_id = ?").run(root));
    },
    /** Live leases of `org`, of every owner or only `account`'s. */
    leases(org: string, account?: string): Lease[] {
      const rows = read((db) =>
        account === undefined
          ? db
              .prepare(
                "SELECT root_id, account, expires_at FROM member_leases WHERE org = ? AND ended_at IS NULL",
              )
              .all(org)
          : db
              .prepare(
                "SELECT root_id, account, expires_at FROM member_leases WHERE org = ? AND account = ? AND ended_at IS NULL",
              )
              .all(org, account),
      );
      return rows.map((raw) => {
        const row = LeaseRow.parse(raw);
        return { root: row.root_id, account: row.account, expiresAt: row.expires_at };
      });
    },
    leaseOwners(org: string): string[] {
      return read((db) =>
        db
          .prepare("SELECT DISTINCT account FROM member_leases WHERE org = ? AND ended_at IS NULL")
          .all(org),
      ).map((raw) => Account.parse(raw).account);
    },
    renew(leases: readonly Lease[]) {
      if (leases.length === 0) return;
      store.atomic((db) => {
        const renew = db.prepare(
          "UPDATE member_leases SET expires_at = ? WHERE root_id = ? AND ended_at IS NULL",
        );
        for (const lease of leases) renew.run(lease.expiresAt, lease.root);
      });
    },
    /** Marks a tree's lease ended, and why: what its page says until its owner resumes it. */
    end(root: string, reason: StopReason, now: number) {
      store.atomic((db) =>
        db
          .prepare(
            "UPDATE member_leases SET ended_at = ?, ended_reason = ? WHERE root_id = ? AND ended_at IS NULL",
          )
          .run(now, reason, root),
      );
    },
    stopReason(root: string): StopReason | undefined {
      const raw = read((db) =>
        db
          .prepare(
            "SELECT ended_reason FROM member_leases WHERE root_id = ? AND ended_at IS NOT NULL",
          )
          .get(root),
      );
      return raw ? Ended.parse(raw).ended_reason : undefined;
    },
    policy(org: string): { version: number; offlineMinutes: number | undefined } | undefined {
      const raw = read((db) =>
        db.prepare("SELECT version, offline_minutes FROM member_policy WHERE org = ?").get(org),
      );
      if (!raw) return undefined;
      const row = PolicyRow.parse(raw);
      return { version: row.version, offlineMinutes: row.offline_minutes ?? undefined };
    },
    /** Keeps a policy version's allowance, unless a higher version is already kept. */
    putPolicy(org: string, version: number, offlineMinutes: number | undefined) {
      store.atomic((db) =>
        db
          .prepare(
            `INSERT INTO member_policy (org, version, offline_minutes) VALUES (?, ?, ?)
             ON CONFLICT (org) DO UPDATE SET version = excluded.version,
               offline_minutes = excluded.offline_minutes WHERE excluded.version > member_policy.version`,
          )
          .run(org, version, offlineMinutes ?? null),
      );
    },
  };
}
export type MemberWorkStore = ReturnType<typeof memberWorkStore>;
