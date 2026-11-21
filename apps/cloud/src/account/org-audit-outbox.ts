import { z } from "zod";
import type { DirectoryEntry } from "./org-directory.ts";
import type { WorkosOrgs } from "./workos-orgs.ts";

/** Entries sent per drain. */
const DRAIN_LIMIT = 50;
/** Tries sent at the next drain (the minute's cron at the latest) before backing off. */
const PROMPT_TRIES = 5;
const MAX_BACKOFF_MS = 60 * 60_000;
/** An entry WorkOS still refuses after this many tries is dropped, with a warning. */
const MAX_TRIES = 40;

const OutboxRow = z.object({
  key: z.string(),
  org_id: z.string(),
  event: z.string(),
  tries: z.number(),
});

/**
 * The audit entries the members feed owes each organization's WorkOS copy (ADR 0206 §6,
 * amendment 1). An entry is queued by a statement in the same D1 batch as the change it records,
 * so it exists exactly when the change committed, and is sent, with an idempotency key derived
 * from the WorkOS event, until WorkOS takes it: a replay or a retry writes nothing more.
 */
/** One entry per WorkOS event, organization and member: the outbox's key and WorkOS's. */
const entryKey = (event: string, org: string, account: string) =>
  `workos-event:${event}:${org}:${account}`;

export function auditOutbox(deps: {
  db: D1Database;
  workos: Pick<WorkosOrgs, "createAuditEvent">;
  now: () => number;
}) {
  const { db, now } = deps;
  return {
    /** The statement that queues `entry`; names and digests only, never a person's details. */
    async queueing(entry: DirectoryEntry): Promise<D1PreparedStatement> {
      const key = entryKey(entry.event, entry.org, entry.account);
      const event = {
        action: entry.action,
        occurred_at: entry.occurredAt,
        actor: { type: entry.actor, id: entry.actor === "idp" ? "directory" : "workos" },
        targets: [{ type: "member", id: entry.account }],
        // Delivered by WorkOS, not asked by a caller: there is no address to record.
        context: { location: "0.0.0.0", user_agent: "workos-events" },
        metadata: { ...entry.metadata, workos_event: entry.event },
      };
      return db
        .prepare(
          "INSERT INTO org_audit_outbox (key, org_id, event, tries, next_at) VALUES (?1, ?2, ?3, 0, ?4) ON CONFLICT (key) DO NOTHING",
        )
        .bind(key, entry.org, JSON.stringify(event), now());
    },
    /**
     * The `org.member.removed` entries WorkOS's deletion of the user at `event.created_at` makes
     * in one statement, one per directory-managed membership it removes, shaped and keyed as
     * `queueing` makes them; runs in its batch before the rows move (`OrgStore.removingAccount`).
     */
    queueingAccountRemovals: (account: string, event: { id: string; created_at: string }) =>
      db
        .prepare(
          `INSERT INTO org_audit_outbox (key, org_id, event, tries, next_at)
           SELECT 'workos-event:' || ?1 || ':' || org_id || ':' || account_id, org_id,
             json_object(
               'action', 'org.member.removed',
               'occurred_at', ?2,
               'actor', json_object('type', 'idp', 'id', 'directory'),
               'targets', json_array(json_object('type', 'member', 'id', account_id)),
               'context', json_object('location', '0.0.0.0', 'user_agent', 'workos-events'),
               'metadata', json_object('role_before', role, 'workos_event', ?1)
             ), 0, ?4
           FROM org_members
           WHERE account_id = ?3 AND status != 'removed' AND version <= ?2 AND directory_managed = 1
           ON CONFLICT (key) DO NOTHING`,
        )
        .bind(event.id, event.created_at, account, now()),
    /** Sends what is due; what WorkOS doesn't take waits for a later drain. Never throws. */
    async drain(): Promise<void> {
      let rows;
      try {
        ({ results: rows } = await db
          .prepare(
            "SELECT key, org_id, event, tries FROM org_audit_outbox WHERE next_at <= ? ORDER BY next_at LIMIT ?",
          )
          .bind(now(), DRAIN_LIMIT)
          .all());
      } catch {
        return;
      }
      for (const raw of rows) {
        // Rows this Worker wrote (ADR 0125).
        const row = OutboxRow.parse(raw);
        try {
          await deps.workos.createAuditEvent(row.org_id, JSON.parse(row.event), row.key);
          await db.prepare("DELETE FROM org_audit_outbox WHERE key = ?").bind(row.key).run();
        } catch {
          const tries = row.tries + 1;
          if (tries >= MAX_TRIES) {
            console.warn(JSON.stringify({ event: "org_audit_dropped", tries }));
            await db
              .prepare("DELETE FROM org_audit_outbox WHERE key = ?")
              .bind(row.key)
              .run()
              .catch(() => {});
            continue;
          }
          const wait =
            tries < PROMPT_TRIES
              ? 0
              : Math.min(60_000 * 2 ** (tries - PROMPT_TRIES), MAX_BACKOFF_MS);
          await db
            .prepare("UPDATE org_audit_outbox SET tries = ?2, next_at = ?3 WHERE key = ?1")
            .bind(row.key, tries, now() + wait)
            .run()
            .catch(() => {});
        }
      }
    },
  };
}
export type AuditOutbox = ReturnType<typeof auditOutbox>;
