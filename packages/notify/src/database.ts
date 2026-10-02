import { chmodSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
import {
  Notification,
  NotificationDevice,
  NotificationPreferences,
  NotificationAddress,
  ThreadId,
  type DeviceId,
  type Event,
} from "@ace/protocol";
import {
  CompactThread,
  Pending,
  advance,
  content,
  InteractionLink,
  interactionLink,
} from "./model.ts";

const Job = z.object({
  id: z.number().int(),
  device: NotificationDevice,
  notification: Notification,
  attempts: z.number().int(),
  expires: z.number(),
  generation: z.number().int().nonnegative(),
});
export type Job = z.infer<typeof Job>;
const relevant = new Set([
  "thread.created",
  "thread.updated",
  "interaction.opened",
  "interaction.closed",
  "background_task.started",
  "background_task.updated",
]);

/** All writes are bounded, synchronous SQLite transactions around pure policy. */
export class NotificationDatabase {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private windowMs: number;
  constructor(path: string, windowMs = 5000) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 0)
      throw new Error("Invalid coalescing window");
    this.windowMs = windowMs;
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO cursor VALUES(1,0);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions (thread TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread,id));
      CREATE INDEX IF NOT EXISTS interaction_first ON interactions(thread,seq);
      CREATE TABLE IF NOT EXISTS tasks (thread TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(thread,id));
      CREATE TABLE IF NOT EXISTS pending (thread TEXT PRIMARY KEY, due INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_due ON pending(due);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, body TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS snoozes (thread TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, device TEXT NOT NULL, thread TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, expires INTEGER NOT NULL, generation INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(due);
      CREATE INDEX IF NOT EXISTS jobs_device ON jobs(device);
      CREATE INDEX IF NOT EXISTS jobs_thread ON jobs(thread);`);
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
  /** Caller passes parsed canonical Event batches, never provider input. */
  ingest(
    events: readonly Event[],
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
        if (!relevant.has(event.payload.type)) continue;
        if (event.threadId.length > 200) throw new Error("Thread id too long");
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
          this.track(event),
        );
        // State is compact and bounded independently of transcript length.
        this.statement("UPDATE threads SET body=? WHERE id=?").run(
          JSON.stringify(CompactThread.parse(state)),
          event.threadId,
        );
        if (pending) {
          if (!prior && this.count("pending") >= 1000)
            throw new Error("Pending notification capacity reached");
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
  /** Active entity rows are indexed on disk; no per-thread live set grows in memory. */
  private track(event: Event): { interactionOpened: boolean; backgroundCompleted: boolean } {
    const p = event.payload;
    let interactionOpened = false,
      backgroundCompleted = false;
    if (p.type === "interaction.opened" && p.interaction.state === "pending") {
      const link = interactionLink(p.interaction);
      interactionOpened =
        this.statement(
          "INSERT INTO interactions VALUES(?,?,?,?) ON CONFLICT(thread,id) DO NOTHING RETURNING id",
        ).get(event.threadId, p.interaction.id, event.seq, JSON.stringify(link)) !== undefined;
    } else if (p.type === "interaction.closed") {
      this.statement("DELETE FROM interactions WHERE thread=? AND id=?").run(
        event.threadId,
        p.interactionId,
      );
    } else if (p.type === "background_task.started" && p.task.status === "running") {
      z.string().max(200).parse(p.task.id);
      this.statement("INSERT INTO tasks VALUES(?,?) ON CONFLICT(thread,id) DO NOTHING").run(
        event.threadId,
        p.task.id,
      );
    } else if (p.type === "background_task.updated" && p.status !== "running") {
      const removed = this.statement("DELETE FROM tasks WHERE thread=? AND id=? RETURNING id").get(
        event.threadId,
        p.taskId,
      );
      backgroundCompleted = removed !== undefined && p.status === "completed";
    }
    return { interactionOpened, backgroundCompleted };
  }
  private count(table: "pending" | "devices" | "jobs"): number {
    return Number(this.statement(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  }
  register(id: DeviceId, input: unknown): void {
    const address = NotificationAddress.parse(input);
    const old = this.statement("SELECT body,revoked FROM devices WHERE id=?").get(id);
    if (old?.revoked) throw new Error("Device revoked");
    if (!old && this.count("devices") >= 128) throw new Error("Device capacity reached");
    const device = NotificationDevice.parse({
      id,
      address,
      preferences: old ? NotificationDevice.parse(JSON.parse(String(old.body))).preferences : {},
    });
    this.statement(
      "INSERT INTO devices VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    ).run(id, JSON.stringify(device));
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
        if (jobs + devices.length > 10_000) break; // Backpressure leaves cursor-derived pending rows durable.
        const threadId = ThreadId.parse(row.thread);
        const value = Pending.parse(JSON.parse(String(row.body)));
        if ((!value.status && !value.backgroundCount) || value.at + 86_400_000 <= now) {
          this.statement("DELETE FROM pending WHERE thread=?").run(threadId);
          continue;
        }
        const state = this.thread(threadId);
        const rowLink = this.statement(
          "SELECT body FROM interactions WHERE thread=? ORDER BY seq LIMIT 1",
        ).get(threadId);
        const link = rowLink ? InteractionLink.parse(JSON.parse(String(rowLink.body))) : undefined;
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
    if (notification.status === "background_done") return true;
    return (
      state.generation === generation &&
      state.status.state === notification.status &&
      (notification.interactionId === undefined ||
        this.statement("SELECT id FROM interactions WHERE thread=? AND id=?").get(
          notification.threadId,
          notification.interactionId,
        ) !== undefined)
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
