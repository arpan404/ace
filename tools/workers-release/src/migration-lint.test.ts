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

  it.each([
    ["DELETE FROM sessions;", "delete-without-where"],
    ["delete from main.sessions returning id;", "delete-without-where"],
    ["UPDATE sessions SET signed_in = NULL;", "update-without-where"],
    [
      "UPDATE OR REPLACE sessions SET made = (SELECT 1 FROM x WHERE x.id = 1);",
      "update-without-where",
    ],
    [
      "WITH old AS (SELECT id FROM sessions WHERE made < 5) DELETE FROM logins;",
      "delete-without-where",
    ],
    ["WITH RECURSIVE n(i) AS (SELECT 1) UPDATE counts SET total = 0;", "update-without-where"],
  ])("refuses the unqualified %j as %s", (sql, rule) => {
    expect(rulesOf(sql)).toEqual([rule]);
  });

  it("passes qualified deletes and updates, and DML that only runs in a trigger", () => {
    const sql = `
      DELETE FROM sessions WHERE expires < 100;
      WITH stale AS (SELECT id FROM logins) DELETE FROM logins WHERE id IN (SELECT id FROM stale);
      UPDATE sessions SET signed_in = 0 WHERE signed_in IS NULL;
      INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = excluded.id;
      CREATE TRIGGER publishers_reserve AFTER INSERT ON publishers
      BEGIN
        DELETE FROM handle_reservations;
        UPDATE publishers SET revision = revision + 1;
      END;
    `;
    expect(rulesOf(sql)).toEqual([]);
  });

  it.each([
    ['ALTER TABLE sessions ADD COLUMN "default" TEXT NOT NULL;'],
    ["ALTER TABLE sessions ADD COLUMN [default] TEXT NOT NULL;"],
    ["ALTER TABLE sessions ADD COLUMN `default` TEXT NOT NULL;"],
  ])("isn't fooled by a column named default: %j", (sql) => {
    expect(rulesOf(sql)).toEqual(["not-null-without-default"]);
  });

  it.each([
    ["ALTER TABLE 'sessions' RENAME TO old;", "rename"],
    ["ALTER TABLE [sessions] DROP COLUMN made;", "drop-column"],
    ["ALTER TABLE `sessions` RENAME COLUMN a TO b;", "rename"],
    ['ALTER TABLE "my ""odd"" table" DROP made;', "drop-column"],
    ["ALTER TABLE main.'sessions' RENAME TO old;", "rename"],
  ])("sees every quoting of a table name: %j", (sql, rule) => {
    expect(rulesOf(sql)).toEqual([rule]);
  });

  it("ignores an opt-out written inside a string literal or a block comment", () => {
    const sql = [
      "INSERT INTO notes (body) VALUES ('",
      "-- migration-lint allow drop-table: this text is data inside a string literal",
      "');",
      "/*",
      "-- migration-lint allow drop-table: this text is inside a block comment, not a marker",
      "*/",
      "DROP TABLE legacy_tokens;",
    ].join("\n");
    expect(rulesOf(sql)).toEqual(["drop-table"]);
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
