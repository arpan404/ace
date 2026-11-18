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
export function sessionStore(db: D1Database, sealer: Sealer) {
  return {
    async put(
      hash: string,
      account: AceAccount,
      refresh: string,
      expires: number,
      signedIn: number,
      pictureUrl?: string,
    ) {
      // A sign-in's session is the person's: only the client that signed in holds it.
      await db
        .prepare(
          "INSERT INTO sessions (token, account, refresh, expires, signed_in, standing) VALUES (?, ?, ?, ?, ?, 'person')",
        )
        .bind(
          hash,
          stored(account, pictureUrl),
          await sealer.seal(refresh, hash),
          expires,
          signedIn,
        )
        .run();
    },
    async get(hash: string, now: number) {
      const raw = await db
        .prepare(
          "SELECT account, refresh, expires, signed_in, standing FROM sessions WHERE token = ? AND expires > ?",
        )
        .bind(hash, now)
        .first();
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
    },
    /** The session was kept on a machine's disk: it never speaks for the person again. */
    async expose(hash: string) {
      await db
        .prepare(
          "UPDATE sessions SET standing = 'exposed' WHERE token = ? AND standing != 'exposed'",
        )
        .bind(hash)
        .run();
    },
    /**
     * Moves a session to `next`, a digest no token has, so its token stops working: whoever
     * copied it holds nothing. Its WorkOS refresh token is sealed again to the new digest. False
     * when the session is gone or another reader holds its refresh lease.
     */
    async retire(hash: string, next: string, now: number): Promise<boolean> {
      const raw = await db
        .prepare(
          "SELECT account, refresh, expires, signed_in, standing FROM sessions WHERE token = ? AND expires > ? AND refreshing_until <= ?",
        )
        .bind(hash, now, now)
        .first();
      if (!raw) return false;
      const row = Row.parse(raw);
      const refresh = await sealer.open(row.refresh, hash);
      const [, removed] = await db.batch([
        db
          .prepare(
            "INSERT INTO sessions (token, account, refresh, expires, signed_in, standing) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            next,
            JSON.stringify(row.account),
            await sealer.seal(refresh, next),
            row.expires,
            row.signed_in,
            row.standing,
          ),
        db
          .prepare("DELETE FROM sessions WHERE token = ? AND refreshing_until <= ?")
          .bind(hash, now),
      ]);
      if (removed && removed.meta.changes > 0) return true;
      // A refresh started in between: the session stays where it was.
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(next).run();
      return false;
    },
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
