import { z } from "zod";
import { bearer, fail, json } from "./respond.ts";
import type { SessionReader } from "./session.ts";
import type { AccountProvider } from "./workos.ts";

const Removed = z.object({ host_id: z.string() });

/**
 * Removes everything D1 holds for an account in one batch, so a failure leaves all of it: the
 * sign-ins that issued its sessions, the sessions, and its machines. Answers the host ids of
 * the machines removed.
 */
export function accountEraser(db: D1Database) {
  return async (accountId: string): Promise<string[]> => {
    const sessions = "SELECT token FROM sessions WHERE json_extract(account, '$.id') = ?";
    const [, , machines] = await db.batch([
      db.prepare(`DELETE FROM logins WHERE session IN (${sessions})`).bind(accountId),
      db.prepare("DELETE FROM sessions WHERE json_extract(account, '$.id') = ?").bind(accountId),
      db.prepare("DELETE FROM machines WHERE account_id = ? RETURNING host_id").bind(accountId),
    ]);
    return (machines?.results ?? []).map((row) => Removed.parse(row).host_id);
  };
}

/**
 * DELETE /v1/account (App Store guideline 5.1.1(v)). WorkOS deletes the user first: if it
 * fails, ace keeps everything so the person can try again. Machines removed from the list are
 * asked to register again, which they can no longer do without a session.
 */
export function deleteAccountRoute(deps: {
  sessions: SessionReader;
  provider: Pick<AccountProvider, "deleteUser">;
  erase: (accountId: string) => Promise<string[]>;
  forgotten?: (hostId: string, accountId: string) => Promise<void>;
}) {
  return async (request: Request): Promise<Response> => {
    const token = bearer(request);
    const session = token ? await deps.sessions.read(token) : undefined;
    if (!session) return fail(401, "unauthenticated");
    const { id } = session.account;
    try {
      await deps.provider.deleteUser(id);
    } catch {
      return fail(502, "delete_failed");
    }
    const hosts = await deps.erase(id);
    await Promise.allSettled(hosts.map((hostId) => deps.forgotten?.(hostId, id)));
    return json(200, { deleted: true });
  };
}
