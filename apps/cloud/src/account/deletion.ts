import { z } from "zod";
import { digest } from "./crypto.ts";
import { bearer, fail, json } from "./respond.ts";
import type { SessionReader } from "./session.ts";
import type { SessionStore } from "./sessions.ts";
import type { AccountProvider } from "./workos.ts";

const Removed = z.object({ host_id: z.string() });
const Pending = z.object({ account_id: z.string() });

/** How long a finished deletion's tombstone outlives it: every grant and sign-in from before it has expired by then. */
export const DELETION_TOMBSTONE_MS = 30 * 86_400_000;

/**
 * What D1 holds of account deletions (the `account_deletions` table). `begin` records the
 * deletion and removes, in one batch, everything but the asking session; `finish` removes the
 * rest once WorkOS has deleted the user. Both are safe to run again.
 */
export function accountDeletions(db: D1Database) {
  const sessionsOf = "SELECT token FROM sessions WHERE json_extract(account, '$.id') = ?";
  /** Everything of the account but sessions and the sign-ins that issued them. */
  const rest = (accountId: string) => [
    db.prepare("DELETE FROM machine_credentials WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM machine_enrollments WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM machines WHERE account_id = ? RETURNING host_id").bind(accountId),
  ];
  return {
    /** Records the deletion and removes all but `keep`'s session. Answers the machines removed. */
    async begin(accountId: string, keep: string, now: number): Promise<string[]> {
      const results = await db.batch([
        db
          .prepare(
            "INSERT INTO account_deletions (account_id, session, started_at) VALUES (?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET session = excluded.session WHERE finished_at IS NULL",
          )
          .bind(accountId, keep, now),
        db
          .prepare(`DELETE FROM logins WHERE session IN (${sessionsOf}) AND session != ?`)
          .bind(accountId, keep),
        db
          .prepare("DELETE FROM sessions WHERE json_extract(account, '$.id') = ? AND token != ?")
          .bind(accountId, keep),
        ...rest(accountId),
      ]);
      return (results.at(-1)?.results ?? []).map((row) => Removed.parse(row).host_id);
    },
    /** The unfinished deletion `hash`'s session asked for, which that session may finish. */
    async askedBy(hash: string): Promise<string | undefined> {
      const raw = await db
        .prepare(
          "SELECT account_id FROM account_deletions WHERE session = ? AND finished_at IS NULL",
        )
        .bind(hash)
        .first();
      return raw ? Pending.parse(raw).account_id : undefined;
    },
    /** Removes what is left of the account, the asking session too, and marks it finished. */
    async finish(accountId: string, now: number): Promise<void> {
      await db.batch([
        db.prepare(`DELETE FROM logins WHERE session IN (${sessionsOf})`).bind(accountId),
        db.prepare("DELETE FROM sessions WHERE json_extract(account, '$.id') = ?").bind(accountId),
        ...rest(accountId),
        db
          .prepare(
            "UPDATE account_deletions SET finished_at = ?, session = '' WHERE account_id = ?",
          )
          .bind(now, accountId),
      ]);
    },
    /** Deletions begun and not finished, oldest first. */
    async unfinished(limit: number): Promise<string[]> {
      const { results } = await db
        .prepare(
          "SELECT account_id FROM account_deletions WHERE finished_at IS NULL ORDER BY started_at LIMIT ?",
        )
        .bind(limit)
        .all();
      return results.map((row) => Pending.parse(row).account_id);
    },
    /** Forgets deletions finished before `before`. */
    async forget(before: number): Promise<void> {
      await db
        .prepare("DELETE FROM account_deletions WHERE finished_at IS NOT NULL AND finished_at < ?")
        .bind(before)
        .run();
    },
  };
}
export type AccountDeletions = ReturnType<typeof accountDeletions>;

/**
 * Finishes a begun deletion: WorkOS deletes the user (a 404 counts as done), then ace removes
 * the rest. False when WorkOS failed; the deletion stays begun, for a retry or the sweep.
 */
async function complete(
  deps: { deletions: AccountDeletions; provider: Pick<AccountProvider, "deleteUser"> },
  accountId: string,
  now: number,
): Promise<boolean> {
  try {
    await deps.provider.deleteUser(accountId);
  } catch {
    return false;
  }
  await deps.deletions.finish(accountId, now);
  return true;
}

/** The answer once a deletion was tried: done, or WorkOS failed and it waits for a retry. */
const finished = (done: boolean) =>
  done ? json(200, { deleted: true }) : fail(502, "delete_failed");

/**
 * DELETE /v1/account (App Store guideline 5.1.1(v)). Only the person's own session may ask
 * (`person` standing, read at the decision): a session a daemon keeps, or one from before
 * standing was kept, is refused. ace records the deletion and removes all but the asking
 * session, then WorkOS deletes the user, then ace removes the rest. A WorkOS failure keeps the
 * asking session; it, or the sweep, finishes the job, even once WorkOS has the user no more.
 * Machines removed from the list are asked to register again, which the deletion now refuses.
 */
export function deleteAccountRoute(deps: {
  sessions: SessionReader;
  standing: Pick<SessionStore, "standingNow">;
  provider: Pick<AccountProvider, "deleteUser">;
  deletions: AccountDeletions;
  now: () => number;
  forgotten?: (hostId: string, accountId: string) => Promise<void>;
}) {
  return async (request: Request): Promise<Response> => {
    const token = bearer(request);
    if (!token) return fail(401, "unauthenticated");
    const hash = await digest(token);
    // A deletion this session began: WorkOS may already have the user no more, so the
    // session can't be read again, but holding its token proves who asked.
    const begun = await deps.deletions.askedBy(hash);
    if (begun) return finished(await complete(deps, begun, deps.now()));
    const session = await deps.sessions.read(token);
    if (!session) return fail(401, "unauthenticated");
    const standing = await deps.standing.standingNow(hash, deps.now());
    if (standing === undefined) return fail(401, "unauthenticated");
    if (standing !== "person") return fail(403, "person_session_required");
    const { id } = session.account;
    const hosts = await deps.deletions.begin(id, hash, deps.now());
    await Promise.allSettled(hosts.map((hostId) => deps.forgotten?.(hostId, id)));
    return finished(await complete(deps, id, deps.now()));
  };
}

/** The sweep's part: finishes deletions nobody retried, and forgets old finished ones. */
export async function sweepDeletions(
  deps: { deletions: AccountDeletions; provider: Pick<AccountProvider, "deleteUser"> },
  now: number,
): Promise<void> {
  for (const accountId of await deps.deletions.unfinished(50)) await complete(deps, accountId, now);
  await deps.deletions.forget(now - DELETION_TOMBSTONE_MS);
}
