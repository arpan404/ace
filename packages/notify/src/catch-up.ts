import type { StatementSync } from "node:sqlite";
import { z } from "zod";
import { Notification } from "@ace/protocol/notifications";
import type { DeviceId } from "@ace/protocol";

/**
 * Additive and idempotent, like the inbox. `alerted` holds the waiting episode (the thread's
 * generation) each device was last told about; `catch_up` holds what a queued catch-up alert
 * covers until it is delivered or given up.
 */
export const catchUpTables = `
  CREATE TABLE IF NOT EXISTS alerted (device TEXT NOT NULL, thread TEXT NOT NULL,
    generation INTEGER NOT NULL, PRIMARY KEY(device,thread));
  CREATE INDEX IF NOT EXISTS alerted_thread ON alerted(thread);
  CREATE TABLE IF NOT EXISTS catch_up (device TEXT NOT NULL, thread TEXT NOT NULL,
    generation INTEGER NOT NULL, PRIMARY KEY(device,thread));`;

const Missed = z.object({
  thread: z.string().max(200),
  title: z.string().max(200),
  generation: z.number().int().nonnegative(),
});
export type Missed = z.infer<typeof Missed>;
/** Threads one catch-up alert names at most. */
const LIMIT = 100;

/** The one alert for a device that missed some: how many threads still need the person. */
export function catchUpNotice(missed: readonly Missed[]): Notification {
  const first = missed[0];
  if (!first) throw new Error("A catch-up alert needs a thread");
  const titles = missed.map((thread) => thread.title || "Untitled thread").join(", ");
  return Notification.parse({
    id: `c:${Math.max(...missed.map((thread) => thread.generation))}:${missed.length}`,
    threadId: first.thread,
    threadIds: missed.map((thread) => thread.thread),
    title: `${missed.length} ${missed.length === 1 ? "thread needs" : "threads need"} you`,
    status: "catch_up",
    message: titles.length > 300 ? `${titles.slice(0, 299)}…` : titles,
    backgroundCount: 0,
    actions: [],
  });
}

/** Which waiting episodes each device has heard about, so catch-up names each only once. */
export class CatchUpLedger {
  private statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  /**
   * Threads that need the person right now and that `device` hasn't been told about in this
   * episode, longest-waiting first. Snoozed threads are left out, and so are threads with an
   * alert still on its way (a coalescing alert, or a job for this device): those arrive alone.
   */
  missed(device: DeviceId, now: number): Missed[] {
    return this.statement(
      `SELECT t.id AS thread, json_extract(t.body,'$.title') AS title,
         json_extract(t.body,'$.generation') AS generation
       FROM threads t
       WHERE json_extract(t.body,'$.status.state')='needs_you'
         AND json_extract(t.body,'$.archived')=0 AND json_extract(t.body,'$.deleted')=0
         AND NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.thread=t.id AND s.until>?)
         AND NOT EXISTS (SELECT 1 FROM pending p WHERE p.thread=t.id)
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.thread=t.id AND j.device=?)
         AND NOT EXISTS (SELECT 1 FROM alerted a WHERE a.device=? AND a.thread=t.id
           AND a.generation=json_extract(t.body,'$.generation'))
       ORDER BY generation LIMIT ${LIMIT}`,
    )
      .all(now, device, device)
      .map((row) => Missed.parse(row));
  }
  /**
   * Rechecks what a queued catch-up covers, just before a send: each wait must still be the
   * thread's current one and still need the person (not answered, archived, deleted or snoozed).
   * Waits that ended are dropped from the cover, so only the ones sent are marked told.
   */
  recheck(device: DeviceId, now: number): Missed[] {
    const still = this.statement(
      `SELECT c.thread AS thread, json_extract(t.body,'$.title') AS title, c.generation AS generation
       FROM catch_up c JOIN threads t ON t.id=c.thread
       WHERE c.device=? AND json_extract(t.body,'$.status.state')='needs_you'
         AND json_extract(t.body,'$.archived')=0 AND json_extract(t.body,'$.deleted')=0
         AND json_extract(t.body,'$.generation')=c.generation
         AND NOT EXISTS (SELECT 1 FROM snoozes s WHERE s.thread=t.id AND s.until>?)
       ORDER BY c.generation`,
    )
      .all(device, now)
      .map((row) => Missed.parse(row));
    this.cover(device, still);
    return still;
  }
  /** Whether a catch-up alert for `device` is already queued. */
  queued(device: DeviceId): boolean {
    return (
      this.statement(
        "SELECT 1 FROM jobs WHERE device=? AND json_extract(body,'$.status')='catch_up' LIMIT 1",
      ).get(device) !== undefined
    );
  }
  /** Records what a newly queued catch-up alert covers, replacing any stale record. */
  cover(device: DeviceId, missed: readonly Missed[]): void {
    this.statement("DELETE FROM catch_up WHERE device=?").run(device);
    for (const thread of missed)
      this.statement("INSERT INTO catch_up VALUES(?,?,?)").run(
        device,
        thread.thread,
        thread.generation,
      );
  }
  /** A catch-up alert finished: delivered, its threads count as told; otherwise they stay owed. */
  settle(device: DeviceId, delivered: boolean): void {
    if (delivered)
      this.statement(
        "INSERT INTO alerted SELECT device,thread,generation FROM catch_up WHERE device=? ON CONFLICT(device,thread) DO UPDATE SET generation=excluded.generation",
      ).run(device);
    this.statement("DELETE FROM catch_up WHERE device=?").run(device);
  }
  /** A needs-you alert reached `device`: this episode is told. */
  alerted(device: DeviceId, thread: string, generation: number): void {
    this.statement(
      "INSERT INTO alerted VALUES(?,?,?) ON CONFLICT(device,thread) DO UPDATE SET generation=excluded.generation",
    ).run(device, thread, generation);
  }
  forgetThread(thread: string): void {
    this.statement("DELETE FROM alerted WHERE thread=?").run(thread);
    this.statement("DELETE FROM catch_up WHERE thread=?").run(thread);
  }
  forgetDevice(device: DeviceId): void {
    this.statement("DELETE FROM alerted WHERE device=?").run(device);
    this.statement("DELETE FROM catch_up WHERE device=?").run(device);
  }
}
