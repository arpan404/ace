import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** Put the thread's details back inside its client column, as rows before thread_cold were. */
const embedDetails = `UPDATE threads SET client = json_set(COALESCE(client, '{}'), '$.details', json('{"mode":"local"}'))`;
const embedded = (db: DatabaseSync) =>
  Number(
    db
      .prepare("SELECT COUNT(*) AS n FROM threads WHERE json_type(client, '$.details') IS NOT NULL")
      .get()?.n,
  );

it("the move into thread_cold runs on the first open of an older home and not on later opens", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-thread-cold-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const raw = (run: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(path);
    try {
      run(db);
    } finally {
      db.close();
    }
  };
  const first = new Store(path, console.error);
  const id = createDevThread(first, first.createWorkspace("/repo", "Repo", 1)).id;
  first.close();

  // A later open does not read every thread looking for values to move: a row direct SQL
  // wrote in the old layout stays as it is, and still reads correctly.
  raw((db) => db.exec(embedDetails));
  const second = new Store(path, console.error);
  expect(second.getThread(id)?.details).toEqual({ mode: "local" });
  second.close();
  raw((db) => expect(embedded(db)).toBe(1));

  // A home from before the marker moves its values once.
  raw((db) => db.exec("DROP TABLE thread_cold_moved"));
  const third = new Store(path, console.error);
  expect(third.getThread(id)?.details).toEqual({ mode: "local" });
  third.close();
  raw((db) => expect(embedded(db)).toBe(0));
});
