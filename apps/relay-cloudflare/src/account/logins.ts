import { z } from "zod";
import { AceAccountGrant } from "@ace/protocol/ace-account";
import type { Sealer } from "./crypto.ts";

const Phase = z.enum(["new", "browser", "exchanging", "complete", "failed"]);
const Row = z.object({
  id: z.string(),
  secret: z.string(),
  expires: z.number(),
  phase: Phase,
  binding: z.string().nullable(),
  verifier: z.string().nullable(),
  session: z.string().nullable(),
  issued: z.string().nullable(),
  /** Where the browser goes when the sign-in ends (return-to.ts), if the app asked. */
  return_to: z.string().nullable(),
});
export type LoginRow = z.infer<typeof Row>;

const changed = (result: D1Result) => result.meta.changes > 0;
const columns = "id, secret, expires, phase, binding, verifier, session, issued, return_to";

/**
 * Pending sign-ins. A Worker keeps nothing between requests, so each step is a conditional
 * UPDATE on the row's phase: two requests racing for the same step cannot both win.
 * Rows are keyed by the login id's digest; the claim secret, OAuth state and browser binding
 * are digests too.
 */
export function loginStore(db: D1Database, sealer: Sealer) {
  async function one(sql: string, ...values: unknown[]) {
    const raw = await db
      .prepare(sql)
      .bind(...values)
      .first();
    return raw ? Row.parse(raw) : undefined;
  }
  return {
    async count(now: number): Promise<number> {
      const row = await db
        .prepare("SELECT count(*) AS n FROM logins WHERE expires > ?")
        .bind(now)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
    async create(id: string, secret: string, expires: number, returnTo: string | null) {
      await db
        .prepare(
          "INSERT INTO logins (id, secret, expires, phase, return_to) VALUES (?, ?, ?, 'new', ?)",
        )
        .bind(id, secret, expires, returnTo)
        .run();
    },
    get: (id: string, now: number) =>
      one(`SELECT ${columns} FROM logins WHERE id = ? AND expires > ?`, id, now),
    /**
     * The sign-in an OAuth state belongs to, in any phase and even expired (until the sweep), so
     * a late or repeated callback can say the sign-in is over and where to send the browser.
     */
    byState: (state: string) => one(`SELECT ${columns} FROM logins WHERE state = ?`, state),
    /** The browser continued from the sign-in page: only the first time goes to WorkOS. */
    async openBrowser(
      id: string,
      browser: { state: string; binding: string; verifier: string },
      now: number,
    ) {
      return changed(
        await db
          .prepare(
            "UPDATE logins SET phase = 'browser', state = ?, binding = ?, verifier = ? WHERE id = ? AND phase = 'new' AND expires > ?",
          )
          .bind(browser.state, browser.binding, await sealer.seal(browser.verifier, id), id, now)
          .run(),
      );
    },
    openVerifier: (row: LoginRow) =>
      row.verifier ? sealer.open(row.verifier, row.id) : Promise.resolve(undefined),
    /** The callback consumes the state once; its digest stays to recognise a repeat. */
    async startExchange(id: string, now: number) {
      return changed(
        await db
          .prepare(
            "UPDATE logins SET phase = 'exchanging', binding = NULL WHERE id = ? AND phase = 'browser' AND expires > ?",
          )
          .bind(id, now)
          .run(),
      );
    },
    async fail(id: string) {
      await db
        .prepare("UPDATE logins SET phase = 'failed', verifier = NULL WHERE id = ?")
        .bind(id)
        .run();
    },
    /** False when the login was cancelled or expired while WorkOS was answering. */
    async complete(id: string, session: string, grant: AceAccountGrant, now: number) {
      return changed(
        await db
          .prepare(
            "UPDATE logins SET phase = 'complete', verifier = NULL, session = ?, issued = ? WHERE id = ? AND phase = 'exchanging' AND expires > ?",
          )
          .bind(session, await sealer.seal(JSON.stringify(grant), id), id, now)
          .run(),
      );
    },
    async issued(row: LoginRow): Promise<AceAccountGrant | undefined> {
      if (!row.issued) return undefined;
      return AceAccountGrant.parse(JSON.parse(await sealer.open(row.issued, row.id)));
    },
    async claimed(id: string) {
      await db.prepare("UPDATE logins SET claimed = 1 WHERE id = ?").bind(id).run();
    },
    /** Removes a login and any session it issued. Cancellation and expiry use this. */
    async remove(id: string) {
      await db.batch([
        db
          .prepare("DELETE FROM sessions WHERE token = (SELECT session FROM logins WHERE id = ?)")
          .bind(id),
        db.prepare("DELETE FROM logins WHERE id = ?").bind(id),
      ]);
    },
    /**
     * Drops expired logins, the sessions of logins nobody claimed (their tokens were never
     * handed out) and expired sessions.
     */
    async sweep(now: number) {
      await db.batch([
        db
          .prepare(
            "DELETE FROM sessions WHERE token IN (SELECT session FROM logins WHERE expires <= ? AND claimed = 0 AND session IS NOT NULL)",
          )
          .bind(now),
        db.prepare("DELETE FROM logins WHERE expires <= ?").bind(now),
        db.prepare("DELETE FROM sessions WHERE expires <= ?").bind(now),
      ]);
    },
  };
}
export type LoginStore = ReturnType<typeof loginStore>;
