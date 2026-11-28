import { createHash } from "node:crypto";
import { activityOrder, type ActivityOrder, type LiveActivityTarget } from "@ace/notify";
import type { Store } from "./store.ts";

const keepFinished = 256;
const keyOf = ({ token, environment }: LiveActivityTarget) =>
  createHash("sha256").update(environment).update("\n").update(token).digest("hex");

/** A machine's order survives a restart. Remember recently ended tokens across a phone resync. */
export function activityJournal(store: Store) {
  store.atomic((db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_activity_order (
        id INTEGER PRIMARY KEY CHECK (id=1), seq INTEGER NOT NULL, timestamp INTEGER NOT NULL,
        attempted_at INTEGER NOT NULL, done INTEGER NOT NULL, done_seq INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO live_activity_order VALUES (1, 0, 0, 0, 0, 0);
      CREATE TABLE IF NOT EXISTS live_activity_progress (
        token_hash TEXT PRIMARY KEY, started_done INTEGER NOT NULL, ended_at INTEGER
      );
    `),
  );
  const bootAttemptedAt = store.atomic((db) =>
    Number(
      db.prepare("SELECT attempted_at FROM live_activity_order WHERE id=1").get()?.attempted_at,
    ),
  );
  return {
    bootAttemptedAt,
    join(target: LiveActivityTarget): { doneAtJoin: number; ended: boolean } {
      const key = keyOf(target);
      return store.atomic((db) => {
        const row = db
          .prepare("SELECT started_done, ended_at FROM live_activity_progress WHERE token_hash=?")
          .get(key);
        if (row) return { doneAtJoin: Number(row.started_done), ended: row.ended_at !== null };
        const done = Number(
          db.prepare("SELECT done FROM live_activity_order WHERE id=1").get()?.done,
        );
        db.prepare("INSERT INTO live_activity_progress VALUES (?, ?, NULL)").run(key, done);
        return { doneAtJoin: done, ended: false };
      });
    },
    complete(completions: readonly number[]): number {
      return store.atomic((db) => {
        const row = db.prepare("SELECT done, done_seq FROM live_activity_order WHERE id=1").get();
        const seen = Number(row?.done_seq);
        const unseen = completions.filter((seq) => seq > seen);
        const last = unseen.at(-1);
        const done = Number(row?.done) + unseen.length;
        if (last !== undefined)
          db.prepare("UPDATE live_activity_order SET done=?, done_seq=? WHERE id=1").run(
            done,
            last,
          );
        return done;
      });
    },
    reserve(now: number): ActivityOrder {
      return store.atomic((db) => {
        const row = db.prepare("SELECT seq, timestamp FROM live_activity_order WHERE id=1").get();
        const order = activityOrder(
          { seq: Number(row?.seq), timestamp: Number(row?.timestamp) },
          now,
        );
        db.prepare(
          "UPDATE live_activity_order SET seq=?, timestamp=?, attempted_at=? WHERE id=1",
        ).run(order.seq, order.timestamp, now);
        return order;
      });
    },
    end(target: LiveActivityTarget, now: number) {
      store.atomic((db) => {
        db.prepare("UPDATE live_activity_progress SET ended_at=? WHERE token_hash=?").run(
          now,
          keyOf(target),
        );
        db.prepare(
          `DELETE FROM live_activity_progress WHERE token_hash IN
          (SELECT token_hash FROM live_activity_progress WHERE ended_at IS NOT NULL
            ORDER BY ended_at DESC LIMIT -1 OFFSET ${keepFinished})`,
        ).run();
      });
    },
    forgetMissing(targets: readonly LiveActivityTarget[]) {
      store.atomic((db) =>
        db
          .prepare(
            `DELETE FROM live_activity_progress WHERE ended_at IS NULL
            AND token_hash NOT IN (SELECT value FROM json_each(?))`,
          )
          .run(JSON.stringify(targets.map(keyOf))),
      );
    },
  };
}
