import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { Notification, type NotificationFeed } from "@ace/protocol/notifications";
import type { DeviceId } from "@ace/protocol";

/** Rows a phone may still need to catch up on, per device. */
const LIMIT = 100;

/**
 * Additive and idempotent: an existing format-4 database gains the table on open, and an older
 * build ignores it. Cursors are global row ids, so they only grow.
 */
export const inboxTables = `
  CREATE TABLE IF NOT EXISTS inbox (cursor INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL,
    id TEXT NOT NULL, body TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL,
    UNIQUE(device,id));
  CREATE INDEX IF NOT EXISTS inbox_device ON inbox(device,cursor);`;

const Row = z.object({
  cursor: z.number().int().nonnegative(),
  body: z.string(),
  generation: z.number().int().nonnegative(),
});

/**
 * The catch-up feed for clients that can't be woken (local-only iOS notifications). An alert that
 * passed delivery policy for a phone is recorded here before its transport runs, so a suspended
 * app that missed the socket frame can fetch it when it next connects.
 */
export class NotificationInbox {
  private statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  /** A retry of the same alert keeps its first cursor, so a client never sees it twice. */
  record(device: DeviceId, notification: Notification, generation: number, expires: number): void {
    this.statement(
      "INSERT INTO inbox(device,id,body,generation,expires) VALUES(?,?,?,?,?) ON CONFLICT(device,id) DO NOTHING",
    ).run(device, notification.id, JSON.stringify(notification), generation, expires);
    this.statement(
      `DELETE FROM inbox WHERE device=? AND cursor NOT IN
        (SELECT cursor FROM inbox WHERE device=? ORDER BY cursor DESC LIMIT ${LIMIT})`,
    ).run(device, device);
  }
  /**
   * Alerts after `afterCursor` that still describe canonical state. Anything recent that no
   * longer does (the thread went back to work, the approval was answered elsewhere) is listed as
   * retracted, so a client can withdraw an alert it already showed.
   */
  feed(
    device: DeviceId,
    afterCursor: number,
    now: number,
    current: (notification: Notification, generation: number) => boolean,
  ): NotificationFeed {
    this.statement("DELETE FROM inbox WHERE device=? AND expires<=?").run(device, now);
    const head = z
      .number()
      .int()
      .nonnegative()
      .parse(this.statement("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get()?.seq ?? 0);
    // A cursor from beyond this database's history means the database was rebuilt: start over.
    const after = afterCursor > head ? 0 : afterCursor;
    const rows = this.statement(
      `SELECT cursor,body,generation FROM inbox WHERE device=? ORDER BY cursor LIMIT ${LIMIT}`,
    ).all(device);
    const feed: NotificationFeed = { cursor: head, entries: [], retracted: [] };
    for (const input of rows) {
      const row = Row.parse(input);
      const notification = Notification.parse(JSON.parse(row.body));
      if (!current(notification, row.generation)) feed.retracted.push(notification.id);
      else if (row.cursor > after) feed.entries.push({ cursor: row.cursor, notification });
    }
    return feed;
  }
  remove(device: DeviceId): void {
    this.statement("DELETE FROM inbox WHERE device=?").run(device);
  }
}
