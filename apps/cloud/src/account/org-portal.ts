import { z } from "zod";
import type { AceOrgPortalIntent } from "@ace/protocol/ace-org";
import { orgAllows } from "@ace/account-grant/org-roles";
import type { OrgPermission } from "@ace/account-grant/org-roles";
import type { OrgLocks } from "./org-locks.ts";
import { WorkosRefusal } from "./workos-orgs.ts";
import type { WorkosOrgs } from "./workos-orgs.ts";

/** Who may open each Admin Portal intent (ADR 0206 §2.7). */
export const portalPermission: Record<AceOrgPortalIntent, OrgPermission> = {
  sso: "sso:manage",
  dsync: "sso:manage",
  domain_verification: "sso:manage",
  certificate_renewal: "sso:manage",
  log_streams: "sso:manage",
  audit_logs: "audit:read",
};
/** Whether a role may open any Admin Portal intent at all. */
export const opensPortal = (role: string) =>
  Object.values(portalPermission).some((permission) => orgAllows(role, permission));

/** Revocations read per cron run. */
const DRAIN_LIMIT = 50;
/** The longest wait between tries of one revocation. */
const MAX_BACKOFF_MS = 60 * 60_000;
/** Issuing a link and revoking an admin's links hold the same lease for at most this long. */
const PORTAL_LEASE = { ms: 30_000, tries: 15, waitMs: 200 };
const lockName = (org: string, account: string) => `portal:${org}:${account}`;
const Queued = z.object({ org_id: z.string(), account_id: z.string(), queued: z.number() });

/**
 * Admin Portal sessions of people who may no longer open them (ADR 0206 §6). Every removal,
 * deactivation or demotion queues a revocation for the organization and account, in the batch
 * that changes the mirror. A revocation is tried at once and then by the minute cron until WorkOS
 * confirms it, waiting longer after each failure.
 *
 * Issuing a link and revoking an account's links hold one lease per organization and account. A
 * link is issued only while no revocation is queued for it: a revocation queued before the link's
 * check refuses the link, and one queued after it runs once the link exists, so it ends that link.
 */
export function portalRevocations(deps: {
  db: D1Database;
  locks: OrgLocks;
  workos: Pick<WorkosOrgs, "revokePortal" | "portalLink">;
  now: () => number;
}) {
  const { db, locks, now } = deps;

  async function queuedFor(org: string, account: string): Promise<number | undefined> {
    const raw = await db
      .prepare("SELECT queued FROM org_portal_revocations WHERE org_id = ? AND account_id = ?")
      .bind(org, account)
      .first<{ queued: number }>();
    return raw?.queued;
  }

  /** One try, holding the account's lease; true once WorkOS confirmed it. */
  async function attempt(org: string, account: string, tries: number): Promise<boolean> {
    const held = await locks.holding(
      lockName(org, account),
      { ...PORTAL_LEASE, tries },
      async () => {
        const queued = await queuedFor(org, account);
        if (queued === undefined) return true;
        try {
          await deps.workos.revokePortal(org, account);
        } catch (error) {
          // The organization is gone at WorkOS, and its portal sessions with it.
          if (!(error instanceof WorkosRefusal && error.status === 404)) {
            await db
              .prepare(
                `UPDATE org_portal_revocations SET tries = tries + 1,
                   next_at = ?4 + MIN(?5, CASE WHEN tries = 0 THEN 0 ELSE 60000 * (1 << MIN(tries - 1, 20)) END)
                 WHERE org_id = ?1 AND account_id = ?2 AND queued = ?3`,
              )
              .bind(org, account, queued, now(), MAX_BACKOFF_MS)
              .run();
            console.warn(JSON.stringify({ event: "org_portal_revoke_failed" }));
            return false;
          }
        }
        // Queued again meanwhile: that one still runs.
        await db
          .prepare(
            "DELETE FROM org_portal_revocations WHERE org_id = ? AND account_id = ? AND queued = ?",
          )
          .bind(org, account, queued)
          .run();
        return true;
      },
    );
    return held.ok && held.value;
  }

  return {
    /** The statement that queues a revocation, for the batch that changes the membership. */
    queueing: (org: string, account: string) =>
      db
        .prepare(
          `INSERT INTO org_portal_revocations (org_id, account_id, queued, tries, next_at) VALUES (?1, ?2, 1, 0, ?3)
           ON CONFLICT (org_id, account_id) DO UPDATE SET queued = queued + 1, tries = 0, next_at = excluded.next_at`,
        )
        .bind(org, account, now()),
    /** Tries a queued revocation now, without waiting on a link being issued; the cron retries. */
    revokeNow: (org: string, account: string) => attempt(org, account, 1),
    /** Tries every revocation that is due (the minute cron). */
    async drain(): Promise<void> {
      const { results } = await db
        .prepare(
          "SELECT org_id, account_id, queued FROM org_portal_revocations WHERE next_at <= ? ORDER BY next_at LIMIT ?",
        )
        .bind(now(), DRAIN_LIMIT)
        .all();
      for (const raw of results) {
        const row = Queued.parse(raw);
        await attempt(row.org_id, row.account_id, 1);
      }
    },
    /**
     * An Admin Portal link for `admin`, holding their lease, only while no revocation is queued
     * for them and `current` still holds (their membership is as it was checked).
     */
    async link(
      org: string,
      admin: string,
      intent: AceOrgPortalIntent,
      current: () => Promise<boolean>,
    ): Promise<{ ok: true; link: string } | { ok: false; error: "forbidden" | "busy" }> {
      const held = await locks.holding(lockName(org, admin), PORTAL_LEASE, async () => {
        if ((await queuedFor(org, admin)) !== undefined || !(await current()))
          return { ok: false as const, error: "forbidden" as const };
        return { ok: true as const, link: await deps.workos.portalLink(org, intent, admin) };
      });
      return held.ok ? held.value : { ok: false, error: "busy" };
    },
  };
}
export type PortalRevocations = ReturnType<typeof portalRevocations>;
