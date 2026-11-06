import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "./sqlite.ts";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Another process tries to start a write without waiting: "acquired" or "busy". */
async function competingWrite(dir: string, path: string): Promise<string> {
  const script = join(dir, "writer.mjs");
  writeFileSync(
    script,
    `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.ACE_TEST_DB, { timeout: 0 });
try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); process.stdout.write("acquired"); }
catch { process.stdout.write("busy"); }
db.close();`,
  );
  const { stdout } = await run(process.execPath, [script], {
    env: { ...process.env, ACE_TEST_DB: path },
  });
  return stdout;
}

// Closing any descriptor of a database file drops every POSIX lock this process holds on it,
// a live connection's included. A read-only open must not do that to a writer beside it. An
// exclusive rollback-journal transaction is the lock such a close would visibly drop.
test("a write lock held here still blocks another process after a read-only open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-sqlite-locks-"));
  dirs.push(dir);
  const path = join(dir, "store.sqlite");
  const setup = new DatabaseSync(path);
  setup.exec("PRAGMA journal_mode=DELETE; CREATE TABLE rows(id INTEGER)");
  setup.close();

  const writer = new DatabaseSync(path);
  writer.exec("BEGIN EXCLUSIVE; INSERT INTO rows VALUES (1)");
  try {
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.close();
    expect(await competingWrite(dir, path)).toBe("busy");
  } finally {
    writer.exec("COMMIT");
    writer.close();
  }
  // The probe can write once the lock is gone, so "busy" above was the held lock.
  expect(await competingWrite(dir, path)).toBe("acquired");
});
