import { z } from "zod";
import { AceOrgRosterBody } from "@ace/protocol/ace-org";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { HeldRoster, Lease, Revocation, RosterMember, StopReason } from "./rules.ts";

/*
 * The org host's own record of who may run work (ADR 0209 §7): the roster it holds, durable
 * revocations, each member tree's execution lease and any stop still under way, the offline
 * allowance its organization's policy last set, and the latest lease time it recorded. New
 * tables, empty at open, nothing rewritten (ADR 0170). Small: one roster, a row per member seen
 * revoked, a row per member tree.
 */

const schema = [
  `CREATE TABLE IF NOT EXISTS member_roster (
    org TEXT PRIMARY KEY, epoch INTEGER NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL,
    at INTEGER NOT NULL, received_at INTEGER NOT NULL, body TEXT NOT NULL, statement TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS member_revocations (
    org TEXT NOT NULL, account TEXT NOT NULL, version INTEGER NOT NULL, changed INTEGER NOT NULL,
    seen_at INTEGER NOT NULL, PRIMARY KEY (org, account))`,
  // A lease is live while `ended_at` is null. A stop sets `ended_at`, its reason and
  // `stop_pending`, which stays set until the tree's sessions and processes are confirmed gone.
  `CREATE TABLE IF NOT EXISTS member_leases (
    root_id TEXT PRIMARY KEY, org TEXT NOT NULL, account TEXT NOT NULL, held_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, ended_at INTEGER, ended_reason TEXT,
    stop_pending INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS member_policy (
    org TEXT PRIMARY KEY, version INTEGER NOT NULL, offline_minutes INTEGER)`,
  // A delegation to another host recorded before it is sent: until its answer names the child,
  // a stop of the tree can't know whether work started there.
  // `delegation` is what's needed to ask the target later whether it made the child.
  `CREATE TABLE IF NOT EXISTS member_remote_starts (
    id TEXT PRIMARY KEY, org TEXT NOT NULL, root_id TEXT NOT NULL, at INTEGER NOT NULL,
    delegation TEXT NOT NULL)`,
  // A child a member tree made on another host, and by when that host tears it down itself.
  `CREATE TABLE IF NOT EXISTS member_remote_children (
    child_id TEXT PRIMARY KEY, org TEXT NOT NULL, root_id TEXT NOT NULL, bound_at INTEGER NOT NULL)`,
  // Here, a child another host's member tree made: torn down at its deadline, never renewed.
  `CREATE TABLE IF NOT EXISTS member_child_deadlines (
    thread_id TEXT PRIMARY KEY, account TEXT NOT NULL, deadline_at INTEGER NOT NULL,
    done INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS member_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1), high_water INTEGER NOT NULL)`,
];

const RosterRow = z.object({
  epoch: z.number(),
  version: z.number(),
  digest: z.string(),
  at: z.number(),
  received_at: z.number(),
  body: z.string(),
});
const LeaseRow = z.object({ root_id: z.string(), account: z.string(), expires_at: z.number() });
const Account = z.object({ account: z.string() });
const RevocationRow = z.object({ account: z.string(), changed: z.number() });
const PolicyRow = z.object({ version: z.number(), offline_minutes: z.number().nullable() });
const Reason = z.enum(["revoked", "lease_expired", "stopped"]);
const Ended = z.object({ ended_reason: Reason });
const Pending = z.object({
  root_id: z.string(),
  account: z.string(),
  ended_reason: Reason,
  ended_at: z.number(),
});
const Start = z.object({ id: z.string(), at: z.number(), delegation: z.string() });
const Bound = z.object({ bound_at: z.number() });
const Next = z.object({ next: z.number().nullable() });
const Deadline = z.object({
  thread_id: z.string(),
  account: z.string(),
  deadline_at: z.number(),
  done: z.number(),
});
const HighWater = z.object({ high_water: z.number() });

/** The members of a roster body, by account, with WorkOS's time for each one's state. */
export function rosterMembers(body: string): Map<string, RosterMember> {
  const parsed = AceOrgRosterBody.parse(JSON.parse(body));
  return new Map(
    parsed.members.map((member) => {
      const changed = member.changed === undefined ? Number.NaN : Date.parse(member.changed);
      return [
        member.account,
        {
          status: member.status,
          role: member.role,
          ...(Number.isFinite(changed) ? { changed } : {}),
        },
      ];
    }),
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
          .prepare(
            "SELECT epoch, version, digest, at, received_at, body FROM member_roster WHERE org = ?",
          )
          .get(org),
      );
      if (!raw) return undefined;
      const row = RosterRow.parse(raw);
      return {
        org,
        epoch: row.epoch,
        version: row.version,
        digest: row.digest,
        at: row.at,
        receivedAt: row.received_at,
        members: rosterMembers(row.body),
      };
    },
    /**
     * Takes a roster with what it revokes and lifts, in one transaction: a crash leaves either
     * the old roster and its revocations or the new one and all of its own. Answers the accounts
     * it newly revoked.
     */
    takeRoster(
      roster: Omit<HeldRoster, "members" | "receivedAt"> & { body: string; statement: string },
      changes: { revoke: readonly Revocation[]; clear: readonly string[] },
      receivedAt: number,
    ): string[] {
      return store.atomic((db) => {
        db.prepare(
          `INSERT INTO member_roster (org, epoch, version, digest, at, received_at, body, statement)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (org) DO UPDATE SET epoch = excluded.epoch, version = excluded.version,
             digest = excluded.digest, at = excluded.at, received_at = excluded.received_at,
             body = excluded.body, statement = excluded.statement`,
        ).run(
          roster.org,
          roster.epoch,
          roster.version,
          roster.digest,
          roster.at,
          receivedAt,
          roster.body,
          roster.statement,
        );
        const lift = db.prepare("DELETE FROM member_revocations WHERE org = ? AND account = ?");
        for (const account of changes.clear) lift.run(roster.org, account);
        const fresh: string[] = [];
        // A revocation keeps the latest state that revoked: a later one only moves it forward.
        const revoke = db.prepare(
          `INSERT INTO member_revocations (org, account, version, changed, seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (org, account) DO UPDATE SET changed = MAX(changed, excluded.changed)`,
        );
        const had = db.prepare(
          "SELECT 1 AS one FROM member_revocations WHERE org = ? AND account = ?",
        );
        for (const { account, changed } of changes.revoke) {
          if (had.get(roster.org, account) === undefined) fresh.push(account);
          revoke.run(roster.org, account, roster.version, changed, receivedAt);
        }
        return fresh;
      });
    },
    /** Every durable revocation of `org`: the account and the WorkOS time that revoked it. */
    revocations(org: string): Map<string, number> {
      return new Map(
        read((db) =>
          db.prepare("SELECT account, changed FROM member_revocations WHERE org = ?").all(org),
        ).map((raw) => {
          const row = RevocationRow.parse(raw);
          return [row.account, row.changed];
        }),
      );
    },
    /**
     * A member tree's lease, held or taken again: a stopped tree resumes with a fresh one, but
     * not while its stop is still under way.
     */
    hold(org: string, account: string, root: string, now: number, expiresAt: number) {
      store.atomic((db) =>
        db
          .prepare(
            `INSERT INTO member_leases (root_id, org, account, held_at, expires_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (root_id) DO UPDATE SET org = excluded.org, account = excluded.account,
               held_at = excluded.held_at, expires_at = excluded.expires_at, ended_at = NULL,
               ended_reason = NULL, stop_pending = 0
             WHERE member_leases.stop_pending = 0`,
          )
          .run(root, org, account, now, expiresAt),
      );
    },
    /** The tree settled on its own, or was found idle when stopped: its lease goes. */
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
    /** The live lease on `root`, if any. */
    lease(root: string): Lease | undefined {
      const raw = read((db) =>
        db
          .prepare(
            "SELECT root_id, account, expires_at FROM member_leases WHERE root_id = ? AND ended_at IS NULL",
          )
          .get(root),
      );
      if (!raw) return undefined;
      const row = LeaseRow.parse(raw);
      return { root: row.root_id, account: row.account, expiresAt: row.expires_at };
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
    /**
     * Ends these leases and marks each stop pending, durably, before anything is torn down: a
     * stop that fails, or a crash in the middle of one, is retried by the next pass.
     */
    beginStops(stops: readonly { root: string; reason: StopReason }[], now: number) {
      if (stops.length === 0) return;
      store.atomic((db) => {
        const end = db.prepare(
          "UPDATE member_leases SET ended_at = ?, ended_reason = ?, stop_pending = 1 WHERE root_id = ? AND ended_at IS NULL",
        );
        for (const stop of stops) end.run(now, stop.reason, stop.root);
      });
    },
    /** Stops of `org` not yet confirmed: their trees or processes may still run. */
    pendingStops(
      org: string,
    ): { root: string; account: string; reason: StopReason; endedAt: number }[] {
      return read((db) =>
        db
          .prepare(
            "SELECT root_id, account, ended_reason, ended_at FROM member_leases WHERE org = ? AND stop_pending = 1",
          )
          .all(org),
      ).map((raw) => {
        const row = Pending.parse(raw);
        return {
          root: row.root_id,
          account: row.account,
          reason: row.ended_reason,
          endedAt: row.ended_at,
        };
      });
    },
    /** A delegation from `root` to another host is about to be sent. */
    addRemoteStart(id: string, org: string, root: string, at: number, delegation: string) {
      store.atomic((db) =>
        db
          .prepare(
            "INSERT INTO member_remote_starts (id, org, root_id, at, delegation) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, org, root, at, delegation),
      );
    },
    /** Its target said for certain whether it made the child: the start goes. */
    removeRemoteStart(id: string) {
      store.atomic((db) => db.prepare("DELETE FROM member_remote_starts WHERE id = ?").run(id));
    },
    /** Delegations from `root` whose target hasn't said yet whether it made the child. */
    remoteStarts(root: string): { id: string; at: number; delegation: string }[] {
      return read((db) =>
        db
          .prepare("SELECT id, at, delegation FROM member_remote_starts WHERE root_id = ?")
          .all(root),
      ).map((raw) => Start.parse(raw));
    },
    /** The target named the child: the start goes, and the child's teardown bound is kept. */
    nameRemoteChild(start: string, child: string, org: string, root: string, boundAt: number) {
      store.atomic((db) => {
        db.prepare("DELETE FROM member_remote_starts WHERE id = ?").run(start);
        db.prepare(
          `INSERT INTO member_remote_children (child_id, org, root_id, bound_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (child_id) DO UPDATE SET bound_at = MAX(bound_at, excluded.bound_at)`,
        ).run(child, org, root, boundAt);
      });
    },
    /** By when each of `root`'s remote children is torn down by its own host. */
    remoteChildBounds(root: string): number[] {
      return read((db) =>
        db.prepare("SELECT bound_at FROM member_remote_children WHERE root_id = ?").all(root),
      ).map((raw) => Bound.parse(raw).bound_at);
    },
    /** A child made here for another host's member tree, with its fixed deadline. */
    addChildDeadline(thread: string, account: string, deadlineAt: number) {
      store.atomic((db) =>
        db
          .prepare(
            `INSERT INTO member_child_deadlines (thread_id, account, deadline_at) VALUES (?, ?, ?)
             ON CONFLICT (thread_id) DO NOTHING`,
          )
          .run(thread, account, deadlineAt),
      );
    },
    childDeadline(thread: string): { deadlineAt: number; done: boolean } | undefined {
      const raw = read((db) =>
        db.prepare("SELECT * FROM member_child_deadlines WHERE thread_id = ?").get(thread),
      );
      if (!raw) return undefined;
      const row = Deadline.parse(raw);
      return { deadlineAt: row.deadline_at, done: row.done === 1 };
    },
    /** Children here whose deadline has come and that aren't torn down yet. */
    dueChildren(now: number): string[] {
      return read((db) =>
        db
          .prepare(
            "SELECT * FROM member_child_deadlines WHERE done = 0 AND deadline_at <= ? ORDER BY deadline_at",
          )
          .all(now),
      ).map((raw) => Deadline.parse(raw).thread_id);
    },
    /** The earliest deadline not yet reached, for its timer. */
    nextChildDeadline(): number | undefined {
      const raw = read((db) =>
        db
          .prepare("SELECT MIN(deadline_at) AS next FROM member_child_deadlines WHERE done = 0")
          .get(),
      );
      const next = Next.parse(raw).next;
      return next ?? undefined;
    },
    childTornDown(thread: string) {
      store.atomic((db) =>
        db.prepare("UPDATE member_child_deadlines SET done = 1 WHERE thread_id = ?").run(thread),
      );
    },
    /** The tree's sessions and its owner's processes are confirmed gone. */
    confirmStop(root: string) {
      store.atomic((db) =>
        db.prepare("UPDATE member_leases SET stop_pending = 0 WHERE root_id = ?").run(root),
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
    /** The latest lease time this host recorded, which a restart's clock never starts behind. */
    highWater(): number | undefined {
      const raw = read((db) =>
        db.prepare("SELECT high_water FROM member_clock WHERE id = 1").get(),
      );
      return raw ? HighWater.parse(raw).high_water : undefined;
    },
    recordTime(at: number) {
      store.atomic((db) =>
        db
          .prepare(
            `INSERT INTO member_clock (id, high_water) VALUES (1, ?)
             ON CONFLICT (id) DO UPDATE SET high_water = MAX(high_water, excluded.high_water)`,
          )
          .run(at),
      );
    },
  };
}
export type MemberWorkStore = ReturnType<typeof memberWorkStore>;
