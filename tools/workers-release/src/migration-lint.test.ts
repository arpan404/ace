import { describe, expect, it } from "vitest";
import { lintMigration, lintMigrations } from "./migration-lint.ts";

const rulesOf = (sql: string) => lintMigration("0009_change.sql", sql).map((p) => p.rule);

describe("migration lint", () => {
  it("passes migrations that only add", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, made INTEGER NOT NULL);
      CREATE INDEX grants_made ON grants (made);
      ALTER TABLE sessions ADD COLUMN signed_in INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE logins ADD COLUMN return_to TEXT;
      INSERT INTO settings (key, value) VALUES ('mode', 'on');
    `;
    expect(lintMigration("0004_add.sql", sql)).toEqual([]);
  });

  it.each([
    ["DROP TABLE sessions;", "drop-table"],
    ["drop table if exists sessions;", "drop-table"],
    ["DROP VIEW live_entries;", "drop-view"],
    ["ALTER TABLE sessions DROP COLUMN signed_in;", "drop-column"],
    ["ALTER TABLE sessions DROP signed_in;", "drop-column"],
    ["ALTER TABLE sessions RENAME TO old_sessions;", "rename"],
    ['ALTER TABLE "sessions" RENAME COLUMN made TO created;', "rename"],
    ["ALTER TABLE sessions ADD COLUMN owner TEXT NOT NULL;", "not-null-without-default"],
    ["alter table\n  sessions\n  add owner text not null;", "not-null-without-default"],
  ])("refuses %j as %s", (sql, rule) => {
    expect(rulesOf(sql)).toEqual([rule]);
  });

  it("refuses each destructive statement in a table rebuild, at its own line", () => {
    const sql = [
      "CREATE TABLE sessions_new (id TEXT PRIMARY KEY);",
      "INSERT INTO sessions_new SELECT id FROM sessions;",
      "DROP TABLE sessions;",
      "ALTER TABLE sessions_new RENAME TO sessions;",
    ].join("\n");
    expect(lintMigration("0005_rebuild.sql", sql).map((p) => [p.rule, p.line])).toEqual([
      ["drop-table", 3],
      ["rename", 4],
    ]);
  });

  it("ignores keywords inside comments and string literals", () => {
    const sql = `
      -- DROP TABLE sessions; was considered and rejected
      /* ALTER TABLE sessions RENAME TO x; */
      INSERT INTO notes (body) VALUES ('DROP TABLE sessions; it''s fine');
    `;
    expect(rulesOf(sql)).toEqual([]);
  });

  it("allows a destructive statement when the file opts out with a reason", () => {
    const sql = `
      -- migration-lint allow drop-table: legacy_tokens has been unread since v1.4, released 2026-08
      DROP TABLE legacy_tokens;
    `;
    expect(lintMigration("0006_contract.sql", sql)).toEqual([]);
  });

  it("allows only the rules the file names", () => {
    const sql = `
      -- migration-lint allow drop-table: legacy_tokens has been unread since v1.4, released 2026-08
      DROP TABLE legacy_tokens;
      ALTER TABLE sessions DROP COLUMN made;
    `;
    expect(rulesOf(sql)).toEqual(["drop-column"]);
  });

  it("refuses an opt-out without a real reason", () => {
    const problems = lintMigration(
      "0007.sql",
      "-- migration-lint allow drop-table: fine\nDROP TABLE legacy_tokens;",
    );
    expect(problems.map((p) => [p.rule, p.line])).toEqual([
      ["opt-out", 1],
      ["drop-table", 2],
    ]);
  });

  it("refuses an opt-out naming an unknown rule", () => {
    const problems = lintMigration(
      "0007.sql",
      "-- migration-lint allow everything: trust me, this is all fine to run\nSELECT 1;",
    );
    expect(problems.map((p) => p.rule)).toEqual(["opt-out"]);
    expect(problems[0]?.message).toContain("unknown rule");
  });

  it("refuses an opt-out that allows nothing, so stale markers don't linger", () => {
    const problems = lintMigration(
      "0008.sql",
      "-- migration-lint allow rename: copied from the last contract migration by mistake\nCREATE TABLE t (id TEXT);",
    );
    expect(problems.map((p) => p.message)).toEqual([
      "the opt-out for rename allows nothing in this file; remove it",
    ]);
  });

  it("names the file of each problem across a set", () => {
    const problems = lintMigrations([
      { file: "cloud/0001.sql", sql: "CREATE TABLE a (id TEXT);" },
      { file: "market/0002.sql", sql: "DROP TABLE b;" },
    ]);
    expect(problems.map((p) => p.file)).toEqual(["market/0002.sql"]);
  });
});
