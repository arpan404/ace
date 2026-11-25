import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { Notification, NotificationFeed } from "@ace/protocol/notifications";
import { ThreadId, type DeviceId } from "@ace/protocol";

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
  CREATE INDEX IF NOT EXISTS inbox_device ON inbox(device,cursor);
  CREATE TABLE IF NOT EXISTS inbox_checkpoint (device TEXT PRIMARY KEY, cursor INTEGER NOT NULL);`;

const Row = z.object({
  cursor: z.number().int().nonnegative(),
  body: z.string(),
  generation: z.number().int().nonnegative(),
});

/**
 * A feed as the inbox reads it: each retraction keeps the thread it is about, so the daemon can
 * drop what a socket may not read (an organization member's) before the feed leaves it.
 */
export const InboxFeed = NotificationFeed.extend({
  /**
   * The newest cursor this device (and its linked ids) holds, or its checkpoint when none: all
   * an organization member's feed cursor may reveal of the host's global inbox head.
   */
  seen: z.number().int().nonnegative(),
  retracted: z.array(z.object({ id: z.string(), threadId: ThreadId })).max(LIMIT),
});
export type InboxFeed = z.infer<typeof InboxFeed>;

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
  /**
   * A retry of the same alert keeps its first cursor, so a client never sees it twice. Returns
   * that cursor, which the live alert carries.
   */
  record(
    device: DeviceId,
    notification: Notification,
    generation: number,
    expires: number,
  ): number | undefined {
    this.statement(
      "INSERT INTO inbox(device,id,body,generation,expires) VALUES(?,?,?,?,?) ON CONFLICT(device,id) DO NOTHING",
    ).run(device, notification.id, JSON.stringify(notification), generation, expires);
    this.statement(
      `DELETE FROM inbox WHERE device=? AND cursor NOT IN
        (SELECT cursor FROM inbox WHERE device=? ORDER BY cursor DESC LIMIT ${LIMIT})`,
    ).run(device, device);
    const row = this.statement("SELECT cursor FROM inbox WHERE device=? AND id=?").get(
      device,
      notification.id,
    );
    return Row.shape.cursor.safeParse(row?.cursor).data;
  }
  /**
   * Alerts after `afterCursor` that still describe canonical state. Anything recent that no
   * longer does (the thread went back to work, the approval was answered elsewhere) is listed as
   * retracted, so a client can withdraw an alert it already showed.
   *
   * `linked` are the device's other ids, which the daemon has proven are the same install (ADR
   * 0115, ADR 0221): one phone reached directly and over its account relay. Their alerts read
   * as this device's, each id once, so one saved cursor on the phone never skips an alert
   * recorded under the other id. The checkpoint stays this device's own.
   */
  feed(
    device: DeviceId,
    afterCursor: number | undefined,
    now: number,
    current: (notification: Notification, generation: number) => boolean,
    linked: readonly DeviceId[] = [],
  ): InboxFeed {
    const devices = [device, ...linked.filter((id) => id !== device)];
    const expire = this.statement("DELETE FROM inbox WHERE device=? AND expires<=?");
    for (const id of devices) expire.run(id, now);
    const head = this.head();
    const cursor = afterCursor ?? this.committed(device);
    // A cursor from beyond this database's history means the database was rebuilt: start over.
    const after = cursor > head ? 0 : cursor;
    // An alert recorded under both ids reads at its first cursor. The newest of them, as many as
    // one device keeps, oldest first.
    const rows = this.statement(
      `SELECT * FROM (SELECT min(cursor) AS cursor,body,generation FROM inbox
        WHERE device IN (${devices.map(() => "?").join(",")}) GROUP BY id
        ORDER BY cursor DESC LIMIT ${LIMIT}) ORDER BY cursor`,
    ).all(...devices);
    const feed: InboxFeed = {
      cursor: head,
      seen: Math.max(after, ...rows.map((row) => Row.parse(row).cursor)),
      entries: [],
      retracted: [],
    };
    for (const input of rows) {
      const row = Row.parse(input);
      const notification = Notification.parse(JSON.parse(row.body));
      if (!current(notification, row.generation))
        feed.retracted.push({ id: notification.id, threadId: notification.threadId });
      else if (row.cursor > after) feed.entries.push({ cursor: row.cursor, notification });
    }
    return feed;
  }
  checkpoint(device: DeviceId, cursor: number | undefined): InboxFeed {
    if (cursor !== undefined && cursor <= this.head()) {
      // Restrict receipts to devices with a feed. A duplicate or delayed receipt cannot rewind it.
      this.statement(
        `INSERT INTO inbox_checkpoint(device,cursor) SELECT id,? FROM devices WHERE id=? AND revoked=0
          ON CONFLICT(device) DO UPDATE SET cursor=max(cursor,excluded.cursor)`,
      ).run(cursor, device);
    }
    const committed = this.committed(device);
    return { cursor: committed, seen: committed, entries: [], retracted: [] };
  }
  private committed(device: DeviceId): number {
    const row = this.statement("SELECT cursor FROM inbox_checkpoint WHERE device=?").get(device);
    return Row.shape.cursor.parse(row?.cursor ?? 0);
  }
  private head(): number {
    return Row.shape.cursor.parse(
      this.statement("SELECT seq FROM sqlite_sequence WHERE name='inbox'").get()?.seq ?? 0,
    );
  }
  remove(device: DeviceId): void {
    this.statement("DELETE FROM inbox WHERE device=?").run(device);
    this.statement("DELETE FROM inbox_checkpoint WHERE device=?").run(device);
  }
}
