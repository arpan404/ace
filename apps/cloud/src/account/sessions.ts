import { notDeleted } from "./tombstone.ts";
import { z } from "zod";
import { AceAccount } from "@ace/protocol/ace-account";
import type { Sealer } from "./crypto.ts";

/** The account as stored: what clients see, plus the picture address only the backend uses. */
const StoredAccount = AceAccount.extend({ pictureUrl: z.string().max(2048).optional() });
const Row = z.object({
  account: z
    .string()
    .transform((raw): unknown => JSON.parse(raw))
    .pipe(StoredAccount),
  refresh: z.string(),
  expires: z.number(),
  signed_in: z.number().default(0),
  standing: z.enum(["person", "legacy", "exposed"]).catch("exposed"),
});
/**
 * Whether a session may speak for the person (ADR 0190, migration 0004): `person` for a sign-in
 * only the client that made it holds; `legacy` for one from before standing was kept; `exposed`
 * for one a machine kept on its disk.
 */
export type SessionStanding = z.infer<typeof Row>["standing"];
const stored = (account: AceAccount, pictureUrl: string | undefined) =>
  JSON.stringify(pictureUrl ? { ...account, pictureUrl } : account);

/** ace sessions in D1, keyed by the token's digest. Refresh tokens are sealed to that digest. */
/** A session row whose account has no deletion recorded. */
const live = notDeleted("json_extract(sessions.account, '$.id')");

export function sessionStore(db: D1Database, sealer: Sealer) {
  const select = (retired: boolean) =>
    db.prepare(
      // An account with a deletion recorded opens nothing: its asking session only retries it.
      `SELECT account, refresh, expires, signed_in, standing FROM sessions WHERE token = ? AND expires > ?${retired ? "" : " AND retired = 0"} AND ${live}`,
    );
  async function read(hash: string, now: number, retired: boolean) {
    const raw = await select(retired).bind(hash, now).first();
    if (!raw) return undefined;
    const row = Row.parse(raw);
    const { pictureUrl, ...account } = row.account;
    return {
      account,
      pictureUrl,
      expiresAt: row.expires,
      signedInAt: row.signed_in,
      standing: row.standing,
      refresh: () => sealer.open(row.refresh, hash),
    };
  }
  const exposing = (hash: string) =>
    db
      .prepare("UPDATE sessions SET standing = 'exposed' WHERE token = ? AND standing != 'exposed'")
      .bind(hash);
  return {
    /**
     * A new sign-in's session; false, and nothing written, when the account was deleted. `standing` is `person` for an app's sign-in, which only that app
     * holds, and `exposed` for a daemon's (`ace login`), which a machine keeps (ADR 0190).
     */
    async put(
      hash: string,
      account: AceAccount,
      refresh: string,
      expires: number,
      signedIn: number,
      standing: "person" | "exposed",
      pictureUrl?: string,
    ): Promise<boolean> {
      const result = await db
        .prepare(
          `INSERT INTO sessions (token, account, refresh, expires, signed_in, standing) SELECT ?, ?, ?, ?, ?, ? WHERE ${notDeleted()}`,
        )
        .bind(
          hash,
          stored(account, pictureUrl),
          await sealer.seal(refresh, hash),
          expires,
          signedIn,
          standing,
          account.id,
        )
        .run();
      return result.meta.changes > 0;
    },
    /** A session its token still opens: not expired, not retired. */
    get: (hash: string, now: number) => read(hash, now, false),
    /**
     * A session a machine credential lives on, retired or not: a retired session's token opens
     * nothing, but the credential exchanged from it still renews it (ADR 0190).
     */
    held: (hash: string, now: number) => read(hash, now, true),
    /**
     * The session's standing now, read for the decision that issues a grant (ADR 0190).
     * Undefined once it is gone, expired or retired.
     */
    async standingNow(hash: string, now: number): Promise<SessionStanding | undefined> {
      const raw = await db
        .prepare(
          `SELECT standing FROM sessions WHERE token = ? AND retired = 0 AND expires > ? AND ${live}`,
        )
        .bind(hash, now)
        .first<{ standing: string }>();
      return raw ? Row.shape.standing.parse(raw.standing) : undefined;
    },
    /** The statement that marks a session kept on a machine's disk: never the person's again. */
    exposing,
    async expose(hash: string) {
      await exposing(hash).run();
    },
    /** The statement that retires a session's token: it opens nothing from then on. */
    retiring: (hash: string) =>
      db.prepare("UPDATE sessions SET retired = 1 WHERE token = ?").bind(hash),
    /** Claims the right to spend the refresh token for `ms`; false while another holds it. */
    async lease(hash: string, now: number, ms: number): Promise<boolean> {
      const result = await db
        .prepare(
          "UPDATE sessions SET refreshing_until = ? WHERE token = ? AND expires > ? AND refreshing_until <= ?",
        )
        .bind(now + ms, hash, now, now)
        .run();
      return result.meta.changes > 0;
    },
    async release(hash: string) {
      await db.prepare("UPDATE sessions SET refreshing_until = 0 WHERE token = ?").bind(hash).run();
    },
    /**
     * Stores a rotated refresh token and the session's renewed expiry. An UPDATE cannot revive a
     * concurrently revoked session.
     */
    async rotate(
      hash: string,
      account: AceAccount,
      refresh: string,
      expires: number,
      pictureUrl?: string,
    ): Promise<boolean> {
      const result = await db
        .prepare(
          "UPDATE sessions SET account = ?, refresh = ?, expires = ?, refreshing_until = 0 WHERE token = ?",
        )
        .bind(stored(account, pictureUrl), await sealer.seal(refresh, hash), expires, hash)
        .run();
      return result.meta.changes > 0;
    },
    async remove(hash: string) {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(hash).run();
    },
  };
}
export type SessionStore = ReturnType<typeof sessionStore>;
