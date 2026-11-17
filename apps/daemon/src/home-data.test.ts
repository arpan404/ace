import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { readHomeData } from "./home-data.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function newHome(): string {
  const path = mkdtempSync(join(tmpdir(), "ace-home-data-"));
  homes.push(path);
  return path;
}
function database(path: string, sql: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(sql);
  return db;
}

describe("the data formats a home holds", () => {
  it("reads the marker and every database's stored version", () => {
    const root = newHome();
    writeFileSync(
      join(root, "ace-format.json"),
      '{"format":"ace-v1","createdAt":"2026-11-16T00:00:00.000Z"}\n',
    );
    database(
      join(root, "events.sqlite"),
      "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1, 63);",
    ).close();
    database(join(root, "notifications.sqlite"), "PRAGMA user_version = 5;").close();
    mkdirSync(join(root, "spade"));
    database(join(root, "spade", "spade.sqlite"), "PRAGMA user_version = 9;").close();

    expect(readHomeData(root)).toEqual({ home: 1, daemon: 63, notify: 5, spade: 9 });
  });

  it("counts a migration another process committed but hasn't checkpointed yet", () => {
    const root = newHome();
    mkdirSync(join(root, "spade"));
    const spade = database(join(root, "spade", "spade.sqlite"), "PRAGMA user_version = 9;");
    try {
      spade.exec(
        "PRAGMA wal_autocheckpoint = 0; BEGIN; CREATE TABLE later (id INTEGER); PRAGMA user_version = 10; COMMIT;",
      );
      expect(readHomeData(root).spade).toBe(10);
    } finally {
      spade.close();
    }
  });

  it("is null for each file the home doesn't have, and names none unreadable", () => {
    expect(readHomeData(newHome())).toEqual({
      home: null,
      daemon: null,
      notify: null,
      spade: null,
    });
  });

  it("names each file that is there but can't be read, rather than call it absent", () => {
    const root = newHome();
    writeFileSync(join(root, "ace-format.json"), "not a marker");
    writeFileSync(join(root, "notifications.sqlite"), "not a database");
    database(join(root, "events.sqlite"), "CREATE TABLE other (id INTEGER);").close();
    expect(readHomeData(root)).toEqual({
      home: null,
      daemon: null,
      notify: null,
      spade: null,
      unreadable: ["home", "daemon", "notify"],
    });
  });

  it("names a database another process holds locked as unreadable", () => {
    const root = newHome();
    mkdirSync(join(root, "spade"));
    const spade = database(join(root, "spade", "spade.sqlite"), "PRAGMA user_version = 9;");
    try {
      spade.exec(
        "PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE held (id INTEGER);",
      );
      expect(readHomeData(root)).toMatchObject({ spade: null, unreadable: ["spade"] });
    } finally {
      spade.exec("COMMIT;");
      spade.close();
    }
  });
});
