import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AceAccount } from "@ace/protocol/ace-account";

const SessionRow = z.object({
  account: z
    .string()
    .transform((raw): unknown => JSON.parse(raw))
    .pipe(AceAccount),
  refresh: z.string(),
  expires: z.number(),
});
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only hashed ace tokens and authenticated encryption of WorkOS refresh tokens reach disk. */
export function accountStore(directory: string, key: Uint8Array) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "accounts.sqlite");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, account TEXT NOT NULL, refresh TEXT NOT NULL, expires INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);`);
  function seal(value: string, identity: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(identity));
    return Buffer.concat([
      nonce,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  function open(value: string, identity: string) {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(identity));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8");
  }
  return {
    put(token: string, account: AceAccount, refresh: string, expires: number) {
      const hash = digest(token);
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(
        hash,
        JSON.stringify(account),
        seal(refresh, hash),
        expires,
      );
    },
    get(token: string, now: number) {
      const hash = digest(token);
      const raw = db
        .prepare("SELECT account, refresh, expires FROM sessions WHERE token = ? AND expires > ?")
        .get(hash, now);
      if (!raw) return undefined;
      const row = SessionRow.parse(raw);
      return { account: row.account, refresh: open(row.refresh, hash), expiresAt: row.expires };
    },
    rotate(token: string, account: AceAccount, refresh: string) {
      const hash = digest(token);
      // UPDATE cannot revive a concurrently revoked session.
      return (
        db
          .prepare("UPDATE sessions SET account = ?, refresh = ? WHERE token = ?")
          .run(JSON.stringify(account), seal(refresh, hash), hash).changes > 0
      );
    },
    remove(token: string) {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(digest(token));
    },
    sweep(now: number) {
      db.prepare("DELETE FROM sessions WHERE expires <= ?").run(now);
    },
    close() {
      db.close();
    },
  };
}
