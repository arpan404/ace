import { z } from "zod";
import { AceAccount } from "@ace/protocol/ace-account";
import type { Sealer } from "./crypto.ts";

const Row = z.object({
  account: z
    .string()
    .transform((raw): unknown => JSON.parse(raw))
    .pipe(AceAccount),
  refresh: z.string(),
  expires: z.number(),
});

/** ace sessions in D1, keyed by the token's digest. Refresh tokens are sealed to that digest. */
export function sessionStore(db: D1Database, sealer: Sealer) {
  return {
    async put(hash: string, account: AceAccount, refresh: string, expires: number) {
      await db
        .prepare("INSERT INTO sessions (token, account, refresh, expires) VALUES (?, ?, ?, ?)")
        .bind(hash, JSON.stringify(account), await sealer.seal(refresh, hash), expires)
        .run();
    },
    async get(hash: string, now: number) {
      const raw = await db
        .prepare("SELECT account, refresh, expires FROM sessions WHERE token = ? AND expires > ?")
        .bind(hash, now)
        .first();
      if (!raw) return undefined;
      const row = Row.parse(raw);
      return {
        account: row.account,
        expiresAt: row.expires,
        refresh: () => sealer.open(row.refresh, hash),
      };
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
    /** Stores a rotated refresh token. An UPDATE cannot revive a concurrently revoked session. */
    async rotate(hash: string, account: AceAccount, refresh: string): Promise<boolean> {
      const result = await db
        .prepare(
          "UPDATE sessions SET account = ?, refresh = ?, refreshing_until = 0 WHERE token = ?",
        )
        .bind(JSON.stringify(account), await sealer.seal(refresh, hash), hash)
        .run();
      return result.meta.changes > 0;
    },
    async remove(hash: string) {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(hash).run();
    },
  };
}
export type SessionStore = ReturnType<typeof sessionStore>;
