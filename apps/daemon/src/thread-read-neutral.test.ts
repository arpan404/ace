import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { threadReadNeutral } from "./thread-read-neutral.ts";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE stored_event_rejected (seq INTEGER PRIMARY KEY);
    CREATE TABLE thread_row_trust (thread_id TEXT PRIMARY KEY, revision INTEGER, canonical INTEGER);
    CREATE TABLE events (seq INTEGER PRIMARY KEY, payload TEXT)`);
  return db;
}

it("a write declared neutral to thread reads may change the trust tables", () => {
  const db = database();
  const neutral = threadReadNeutral(db);
  neutral.prepare("INSERT OR IGNORE INTO stored_event_rejected VALUES (?)").run(4);
  neutral.prepare("INSERT INTO thread_row_trust VALUES ('t', 1, 1)").run();
  neutral
    .prepare(
      "INSERT INTO thread_row_trust VALUES ('t', 2, 1) ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision",
    )
    .run();
  neutral.exec("DELETE FROM thread_row_trust");
  expect(neutral.prepare("SELECT seq FROM stored_event_rejected").all()).toEqual([{ seq: 4 }]);
});

it("a write declared neutral to thread reads that touches a thread's rows throws before it runs", () => {
  const db = database();
  db.exec("INSERT INTO events VALUES (1, '{}')");
  const neutral = threadReadNeutral(db);
  expect(() => neutral.prepare("UPDATE events SET payload = '[]'")).toThrow("writes events");
  expect(() => neutral.exec("delete from events")).toThrow("writes events");
  expect(() => neutral.exec('INSERT INTO "events" VALUES (2, 1)')).toThrow("writes events");
  expect(db.prepare("SELECT payload FROM events").all()).toEqual([{ payload: "{}" }]);
});
