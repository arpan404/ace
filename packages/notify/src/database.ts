import { chmodSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "@ace/provider-kit/sqlite";
import { z } from "zod";
import {
  Notification,
  NotificationDevice,
  NotificationPreferences,
  NotificationAddress,
} from "@ace/protocol/notifications";
import { ThreadId, type DeviceId } from "@ace/protocol/ids";
import { CompactThread, Pending, advance, content } from "./model.ts";
import type { MetadataEvent } from "./metadata.ts";
import { InteractionTracking, trackingTables } from "./tracking.ts";

const Job = z.object({
  id: z.number().int(),
  device: NotificationDevice,
  notification: Notification,
  attempts: z.number().int(),
  expires: z.number(),
  generation: z.number().int().nonnegative(),
});
export type Job = z.infer<typeof Job>;
/** All writes are bounded, synchronous SQLite transactions around pure policy. */
export class NotificationDatabase {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private windowMs: number;
  private tracking: InteractionTracking;
  constructor(path: string, windowMs = 5000) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 0)
      throw new Error("Invalid coalescing window");
    this.windowMs = windowMs;
    this.tracking = new InteractionTracking((sql) => this.statement(sql));
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256;
      CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO cursor VALUES(1,0);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions (thread TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread,id));
      CREATE INDEX IF NOT EXISTS interaction_first ON interactions(thread,seq);
      CREATE TABLE IF NOT EXISTS tasks (thread TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(thread,id));
      CREATE TABLE IF NOT EXISTS pending (thread TEXT PRIMARY KEY, due INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_due ON pending(due);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, body TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS snoozes (thread TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_notices (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_notices_expiry ON agent_notices(expires);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, expires INTEGER NOT NULL, generation INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(due);
      CREATE INDEX IF NOT EXISTS jobs_device ON jobs(device);
      CREATE INDEX IF NOT EXISTS jobs_thread ON jobs(thread);
      CREATE TABLE IF NOT EXISTS queue_size (id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
      INSERT OR IGNORE INTO queue_size SELECT 1,count(*) FROM pending;
      CREATE TRIGGER IF NOT EXISTS pending_insert AFTER INSERT ON pending BEGIN UPDATE queue_size SET n=n+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS pending_delete AFTER DELETE ON pending BEGIN UPDATE queue_size SET n=n-1 WHERE id=1; END;
      ${trackingTables}`);
    if (
      !this.db
        .prepare("PRAGMA table_info(devices)")
        .all()
        .some((row) => row.name === "last_seen")
    )
      this.db.exec("ALTER TABLE devices ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS devices_seen ON devices(revoked,last_seen)");
    const version = z
      .number()
      .int()
      .parse(this.db.prepare("PRAGMA user_version").get()?.user_version);
    if (version === 0 || version === 1) {
      // Rebuild older projections with owner eligibility and thread snoozes, preserving device policy.
      this.db.exec(`BEGIN IMMEDIATE; DELETE FROM threads; DELETE FROM interactions;
        DELETE FROM interaction_owners; DELETE FROM agent_status; DELETE FROM tasks;
        DELETE FROM pending; DELETE FROM jobs; UPDATE cursor SET seq=0 WHERE id=1;
        PRAGMA user_version=2; COMMIT;`);
    } else if (version !== 2) throw new Error("Unsupported notification database version");
  }
  private statement(sql: string): StatementSync {
    let value = this.statements.get(sql);
    if (!value) {
      value = this.db.prepare(sql);
      this.statements.set(sql, value);
    }
    return value;
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.statements.clear();
    this.db.close();
  }
  cursor(): number {
    return z.number().int().parse(this.statement("SELECT seq FROM cursor WHERE id=1").get()?.seq);
  }
  /** Caller passes bounded schema-parsed projections, never provider input. */
  ingest(
    events: readonly MetadataEvent[],
    now: number,
    coverage?: { afterSeq: number; throughSeq: number },
  ): void {
    this.transaction(() => {
      let cursor = this.cursor();
      if (coverage && coverage.afterSeq > cursor) throw new Error("Notification replay gap");
      for (const event of events) {
        if (event.seq <= cursor) continue;
        if (!coverage && event.seq !== cursor + 1) throw new Error("Notification replay gap");
        cursor = event.seq;
        if (event.threadId.length > 200) throw new Error("Thread id too long");
        if (event.payload.type === "thread.client.updated") {
          this.snooze(event.threadId, event.payload.snoozedUntil ?? 0);
          continue;
        }
        if (event.payload.type === "thread.created") {
          const state = CompactThread.parse({
            archived: event.payload.thread.archivedAt !== undefined,
            title: event.payload.thread.title.slice(0, 200),
            status: event.payload.thread.status,
          });
          this.statement("INSERT INTO threads VALUES(?,?) ON CONFLICT(id) DO NOTHING").run(
            event.threadId,
            JSON.stringify(state),
          );
          if (event.payload.thread.snoozedUntil !== undefined)
            this.snooze(event.threadId, event.payload.thread.snoozedUntil);
          continue;
        }
        const row = this.statement("SELECT body FROM threads WHERE id=?").get(event.threadId);
        if (!row) throw new Error("Missing notification thread");
        const state = CompactThread.parse(JSON.parse(String(row.body)));
        const prior = this.statement("SELECT body FROM pending WHERE thread=?").get(event.threadId);
        const pending = advance(
          state,
          prior ? Pending.parse(JSON.parse(String(prior.body))) : undefined,
          event,
          now,
          this.windowMs,
          this.tracking.track(event),
        );
        // State is compact and bounded independently of transcript length.
        this.statement("UPDATE threads SET body=? WHERE id=?").run(
          JSON.stringify(CompactThread.parse(state)),
          event.threadId,
        );
        if (pending) {
          if (!prior && this.count("pending") >= 10_000)
            // Disk spool eviction keeps replay advancing even during sustained overload.
            this.statement(
              "DELETE FROM pending WHERE thread=(SELECT thread FROM pending ORDER BY due LIMIT 1)",
            ).run();
          this.statement(
            "INSERT INTO pending VALUES(?,?,?) ON CONFLICT(thread) DO UPDATE SET due=excluded.due,body=excluded.body",
          ).run(event.threadId, pending.due, JSON.stringify(pending));
        } else this.statement("DELETE FROM pending WHERE thread=?").run(event.threadId);
      }
      this.statement("UPDATE cursor SET seq=? WHERE id=1").run(
        coverage ? Math.max(cursor, coverage.throughSeq) : cursor,
      );
    });
  }
  private count(table: "pending" | "devices" | "jobs"): number {
    if (table === "pending")
      return Number(this.statement("SELECT n FROM queue_size WHERE id=1").get()?.n);
    return Number(
      this.statement(
        `SELECT count(*) AS n FROM ${table}${table === "devices" ? " WHERE revoked=0" : ""}`,
      ).get()?.n,
    );
  }
  register(id: DeviceId, input: unknown, now = 0, active: ReadonlySet<DeviceId> = new Set()): void {
    const address = NotificationAddress.parse(input);
    const old = this.statement("SELECT body,revoked FROM devices WHERE id=?").get(id);
    if (old?.revoked) throw new Error("Device revoked");
    if (!old && this.count("devices") >= 128) {
      const candidates = this.statement(
        "SELECT id,body FROM devices WHERE revoked=0 ORDER BY last_seen,id",
      ).all();
      const stale = candidates.find((row) => {
        const device = NotificationDevice.parse(JSON.parse(String(row.body)));
        return device.address.channel === "websocket" && !active.has(device.id);
      });
      if (!stale) throw new Error("Device capacity reached");
      this.statement("DELETE FROM jobs WHERE device=?").run(String(stale.id));
      this.statement("DELETE FROM devices WHERE id=?").run(String(stale.id));
    }
    const device = NotificationDevice.parse({
      id,
      address,
      preferences: old ? NotificationDevice.parse(JSON.parse(String(old.body))).preferences : {},
    });
    this.statement(
      "INSERT INTO devices(id,body,revoked,last_seen) VALUES(?,?,0,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,last_seen=excluded.last_seen",
    ).run(id, JSON.stringify(device), now);
  }
  touch(id: DeviceId, now: number): void {
    this.statement("UPDATE devices SET last_seen=? WHERE id=? AND revoked=0").run(now, id);
  }
  device(id: DeviceId): NotificationDevice | undefined {
    const row = this.statement("SELECT body FROM devices WHERE id=? AND revoked=0").get(id);
    return row ? NotificationDevice.parse(JSON.parse(String(row.body))) : undefined;
  }
  preferences(id: DeviceId, input: unknown): void {
    const device = this.device(id);
    if (!device) throw new Error("Device unavailable");
    device.preferences = NotificationPreferences.parse(input);
    this.statement("UPDATE devices SET body=? WHERE id=? AND revoked=0").run(
      JSON.stringify(device),
      id,
    );
  }
  revoke(id: DeviceId): void {
    this.transaction(() => {
      // Tombstones prevent reconnects from restoring a revoked address.
      const existing = this.device(id);
      if (!existing && !this.statement("SELECT id FROM devices WHERE id=?").get(id)) {
        this.register(id, { channel: "websocket", platform: "web" });
      }
      const tombstone = NotificationDevice.parse({
        id,
        address: { channel: "websocket", platform: "web" },
        preferences: {},
      });
      this.statement("UPDATE devices SET body=?,revoked=1 WHERE id=?").run(
        JSON.stringify(tombstone),
        id,
      );
      this.statement("DELETE FROM jobs WHERE device=?").run(id);
    });
  }
  snooze(thread: ThreadId, until: number): void {
    this.thread(thread);
    z.number().int().nonnegative().parse(until);
    this.statement(
      "INSERT INTO snoozes VALUES(?,?) ON CONFLICT(thread) DO UPDATE SET until=excluded.until",
    ).run(thread, until);
  }
  /** Acceptance and fan-out commit together; retried MCP intents keep their stable id. */
  notify(notification: Notification, now: number): void {
    this.transaction(() => {
      this.statement("DELETE FROM agent_notices WHERE expires<=?").run(now);
      if (this.statement("SELECT id FROM agent_notices WHERE id=?").get(notification.id)) return;
      const state = this.thread(notification.threadId);
      const devices = this.statement("SELECT id FROM devices WHERE revoked=0").all();
      if (
        this.count("jobs") + devices.length > 10_000 ||
        Number(this.statement("SELECT count(*) AS n FROM agent_notices").get()?.n) >= 10_000
      )
        throw new Error("Notification queue full");
      const expires = now + 86_400_000;
      this.statement("INSERT INTO agent_notices VALUES(?,?)").run(notification.id, expires);
      if (state.archived || this.snoozed(notification.threadId, now)) return;
      for (const device of devices)
        this.statement(
          "INSERT INTO jobs(device,thread,body,due,expires,generation) VALUES(?,?,?,?,?,?)",
        ).run(
          String(device.id),
          notification.threadId,
          JSON.stringify(notification),
          now,
          expires,
          state.generation,
        );
    });
  }
  snoozed(thread: ThreadId, now: number): boolean {
    return (
      Number(this.statement("SELECT until FROM snoozes WHERE thread=?").get(thread)?.until ?? 0) >
      now
    );
  }
  /** Index-driven bounded batch. Fan-out is at most 128 devices per intent. */
  prepare(now: number): void {
    this.transaction(() => {
      const pending = this.statement(
        "SELECT thread,body FROM pending WHERE due<=? ORDER BY due LIMIT 64",
      ).all(now);
      if (!pending.length) return;
      const devices = this.statement("SELECT id FROM devices WHERE revoked=0").all();
      let jobs = this.count("jobs");
      for (const row of pending) {
        const threadId = ThreadId.parse(row.thread);
        const value = Pending.parse(JSON.parse(String(row.body)));
        if ((!value.status && !value.backgroundCount) || value.at + 86_400_000 <= now) {
          this.statement("DELETE FROM pending WHERE thread=?").run(threadId);
          continue;
        }
        if (jobs + devices.length > 10_000) break; // Leave live pending rows durable under delivery backpressure.
        const state = this.thread(threadId);
        const link = this.tracking.first(threadId);
        const notification = content(threadId, state, value, link);
        const serialized = JSON.stringify(notification);
        for (const device of devices) {
          this.statement(
            "INSERT INTO jobs(device,thread,body,due,expires,generation) VALUES(?,?,?,?,?,?)",
          ).run(
            String(device.id),
            threadId,
            serialized,
            now,
            value.at + 86_400_000,
            state.generation,
          );
          jobs++;
        }
        this.statement("DELETE FROM pending WHERE thread=?").run(threadId);
      }
    });
  }
  private thread(id: ThreadId): CompactThread {
    const row = this.statement("SELECT body FROM threads WHERE id=?").get(id);
    if (!row) throw new Error("Unknown notification thread");
    return CompactThread.parse(JSON.parse(String(row.body)));
  }
  current(notification: Notification, generation: number): boolean {
    const state = this.thread(notification.threadId);
    if (state.archived) return false;
    if (notification.status === "background_done" || notification.status === "agent_says")
      return true;
    return (
      state.generation === generation &&
      state.status.state === notification.status &&
      (notification.interactionId === undefined ||
        this.tracking.eligible(notification.threadId, notification.interactionId))
    );
  }
  due(now: number): Job[] {
    const rows = this.statement(
      "SELECT jobs.*,devices.body AS device_body FROM jobs JOIN devices ON devices.id=jobs.device WHERE jobs.due<=? AND devices.revoked=0 ORDER BY jobs.due LIMIT 16",
    ).all(now);
    return rows.map((row) =>
      Job.parse({
        id: row.id,
        device: JSON.parse(String(row.device_body)),
        notification: JSON.parse(String(row.body)),
        attempts: row.attempts,
        expires: row.expires,
        generation: row.generation,
      }),
    );
  }
  remove(id: number): void {
    this.statement("DELETE FROM jobs WHERE id=?").run(id);
  }
  retry(id: number, attempts: number, due: number): void {
    this.statement("UPDATE jobs SET attempts=?,due=? WHERE id=?").run(attempts, Math.ceil(due), id);
  }
}
