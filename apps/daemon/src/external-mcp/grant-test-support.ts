import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../migrations.ts";
import { GrantStore, type GrantDraft, type GrantSql } from "./grants.ts";
import { GrantTokens } from "./tokens.ts";

/** A daemon database schema in memory, with nested transactions as the Store gives them. */
export function grantDatabase() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  let depth = 0;
  const sql: GrantSql = {
    statement: (text) => db.prepare(text),
    atomic(run) {
      const name = `grant_test_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = run();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
  return { db, sql };
}

/** Grants and tokens over one database, on a clock the test moves. */
export function grantFixture(start = 1_000_000) {
  const { db, sql } = grantDatabase();
  const clock = { now: start };
  let next = 0;
  const now = () => clock.now;
  const revoked: string[] = [];
  const open = () => {
    const grants = new GrantStore(sql, now, () => `grant-${++next}`);
    const tokens = new GrantTokens({
      sql,
      grants,
      now,
      random: randomBytes,
      revoked: (id) => revoked.push(id),
    });
    return { grants, tokens };
  };
  return { db, sql, clock, revoked, open, ...open() };
}

export const draft = (change: Partial<GrantDraft> = {}): GrantDraft => ({
  clientKind: "cimd",
  clientId: "https://client.example/metadata.json",
  name: "Example assistant",
  domain: "client.example",
  scopes: ["threads:read"],
  projects: "all",
  expiresAt: null,
  approvedBy: "device-1",
  ...change,
});
