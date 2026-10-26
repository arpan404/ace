import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DatabaseSync } from "./sqlite.ts";

test("built-in node:sqlite keeps WAL rows and locking across connections", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-sqlite-雪-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "wál.sqlite");
  const first = new DatabaseSync(dbPath);
  const second = new DatabaseSync(dbPath);
  try {
    first.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;");
    second.exec("PRAGMA busy_timeout=0;");
    expect(first.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
    first.exec("CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT);");
    first.exec("INSERT INTO rows(value) VALUES ('one');");
    const committed = second.prepare("SELECT value FROM rows ORDER BY id").all();
    expect(committed.map((row) => row["value"])).toEqual(["one"]);
    first.exec("BEGIN IMMEDIATE; INSERT INTO rows(value) VALUES ('two');");
    const held = second.prepare("SELECT value FROM rows ORDER BY id").all();
    expect(held.map((row) => row["value"])).toEqual(["one"]);
    expect(() => second.exec("INSERT INTO rows(value) VALUES ('blocked');")).toThrow(
      /locked|busy/i,
    );
    first.exec("COMMIT;");
    const released = second.prepare("SELECT value FROM rows ORDER BY id").all();
    expect(released.map((row) => row["value"])).toEqual(["one", "two"]);
    second.exec("INSERT INTO rows(value) VALUES ('three');");
    const writable = first.prepare("SELECT value FROM rows ORDER BY id").all();
    expect(writable.map((row) => row["value"])).toEqual(["one", "two", "three"]);
  } finally {
    first.close();
    second.close();
  }
  const reopened = new DatabaseSync(dbPath);
  try {
    const persisted = reopened.prepare("SELECT value FROM rows ORDER BY id").all();
    expect(persisted.map((row) => row["value"])).toEqual(["one", "two", "three"]);
  } finally {
    reopened.close();
  }
});
