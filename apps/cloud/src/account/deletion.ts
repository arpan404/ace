import { z } from "zod";
import { digest } from "./crypto.ts";
import { bearer, fail, json } from "./respond.ts";
import type { SessionReader } from "./session.ts";
import type { AccountProvider } from "./workos.ts";

const Removed = z.object({ host_id: z.string() });

/**
 * Removes what D1 holds for an account in one batch, so a failure leaves all of it: the
 * sign-ins that issued its sessions, every session but `keep` (the one asking), and its
 * machines. Answers the host ids of the machines removed. Running it again is harmless.
 */
export function accountEraser(db: D1Database) {
  return async (accountId: string, keep: string): Promise<string[]> => {
    const sessions = "SELECT token FROM sessions WHERE json_extract(account, '$.id') = ?";
    const [, , machines] = await db.batch([
      db
        .prepare(`DELETE FROM logins WHERE session IN (${sessions}) AND session != ?`)
        .bind(accountId, keep),
      db
        .prepare("DELETE FROM sessions WHERE json_extract(account, '$.id') = ? AND token != ?")
        .bind(accountId, keep),
      db.prepare("DELETE FROM machines WHERE account_id = ? RETURNING host_id").bind(accountId),
    ]);
    return (machines?.results ?? []).map((row) => Removed.parse(row).host_id);
  };
}

/** Removes one session, by its token's digest, and the sign-in that issued it. */
export function sessionEraser(db: D1Database) {
  return async (hash: string): Promise<void> => {
    await db.batch([
      db.prepare("DELETE FROM logins WHERE session = ?").bind(hash),
      db.prepare("DELETE FROM sessions WHERE token = ?").bind(hash),
    ]);
  };
}

/**
 * DELETE /v1/account (App Store guideline 5.1.1(v)). ace's own rows go first, all but the
 * asking session, then the WorkOS user, then that session. A WorkOS failure keeps the session,
 * so the person can try again and the retry finishes the job. Machines removed from the list
 * are asked to register again, which they can no longer do without a session.
 */
export function deleteAccountRoute(deps: {
  sessions: SessionReader;
  provider: Pick<AccountProvider, "deleteUser">;
  erase: (accountId: string, keep: string) => Promise<string[]>;
  /** Removes the asking session, by its token's digest, and the sign-in that issued it. */
  removeSession: (hash: string) => Promise<void>;
  forgotten?: (hostId: string, accountId: string) => Promise<void>;
}) {
  return async (request: Request): Promise<Response> => {
    const token = bearer(request);
    const session = token ? await deps.sessions.read(token) : undefined;
    if (!token || !session) return fail(401, "unauthenticated");
    const { id } = session.account;
    const hash = await digest(token);
    const hosts = await deps.erase(id, hash);
    await Promise.allSettled(hosts.map((hostId) => deps.forgotten?.(hostId, id)));
    try {
      await deps.provider.deleteUser(id);
    } catch {
      return fail(502, "delete_failed");
    }
    await deps.removeSession(hash);
    return json(200, { deleted: true });
  };
}
