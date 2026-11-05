import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "./sqlite.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function walDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "ace-sqlite-ro-"));
  dirs.push(dir);
  const path = join(dir, "store.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE rows(id INTEGER); INSERT INTO rows VALUES (1)");
  return { path, db };
}

const count = (db: DatabaseSync) => db.prepare("SELECT count(*) AS n FROM rows").get()?.n;

test("a cleanly closed WAL database opens read-only and still refuses writes", () => {
  const { path, db } = walDatabase();
  db.close();
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    expect(count(reader)).toBe(1);
    expect(() => reader.exec("INSERT INTO rows VALUES (2)")).toThrow(/readonly/);
  } finally {
    reader.close();
  }
});

test("a read-only open beside a live writer sees its rows that are only in the WAL", () => {
  const { path, db } = walDatabase();
  try {
    db.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO rows VALUES (2)");
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(count(reader)).toBe(2);
    } finally {
      reader.close();
    }
  } finally {
    db.close();
  }
});

test("a read-only open of a missing database fails without creating it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-sqlite-ro-"));
  dirs.push(dir);
  expect(() => new DatabaseSync(join(dir, "absent.sqlite"), { readOnly: true })).toThrow();
  expect(readdirSync(dir)).toEqual([]);
});
