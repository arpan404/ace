import { z } from "zod";
import type { ThreadStatus } from "@ace/protocol";
import type { Store } from "../../store.ts";

/*
 * The message that tells an agent a failed move left it here, so it carries on (ADR 0191). It is
 * owed durably and sent until it goes: a full engine refuses it now and takes it later, and a
 * restart keeps owing it. Each attempt is a command of its own id, so a refusal's receipt never
 * answers the next one.
 */

const Row = z.object({
  thread_id: z.string(),
  transfer_id: z.string(),
  text: z.string(),
  attempts: z.number(),
  next_at: z.number(),
});

export interface LiveResumePorts {
  store: Store;
  /** Sends the message under `key`; throws when the engine refuses it now. */
  send(threadId: string, key: string, text: string): void;
  status(threadId: string): ThreadStatus | undefined;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(message: string, fields: Record<string, unknown>): void;
}

const maxWaitMs = 60_000;
/** A thread at rest is told now. */
const atRest = new Set<ThreadStatus["state"]>(["done", "new", "failed"]);
/** One working, or asking the person, already carried on: nothing is owed any more. */
const carryingOn = new Set<ThreadStatus["state"]>(["working", "needs_you"]);
/** How long a thread that is neither at rest nor carrying on is left before it is looked at again. */
const lookAgainMs = 5_000;

export class LiveResumes {
  private ports: LiveResumePorts;
  private stopped = new AbortController();
  private wake = new AbortController();
  private running: Promise<void> | undefined;
  constructor(ports: LiveResumePorts) {
    this.ports = ports;
    ports.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS transfer_live_resume (
        thread_id TEXT PRIMARY KEY, transfer_id TEXT NOT NULL, text TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL)`),
    );
  }
  /** Owes the thread `text`, sent as soon as the engine takes it. */
  owe(threadId: string, transferId: string, text: string): void {
    this.ports.store
      .statement(
        `INSERT INTO transfer_live_resume (thread_id, transfer_id, text, attempts, next_at)
        VALUES (?, ?, ?, 0, ?) ON CONFLICT(thread_id) DO UPDATE SET transfer_id=excluded.transfer_id,
        text=excluded.text, attempts=0, next_at=excluded.next_at`,
      )
      .run(threadId, transferId, text, this.ports.now());
    this.kick();
  }
  /** Sends what is due now; returns when the next attempt is due, if any is owed. */
  drain(): number | undefined {
    const { ports } = this;
    const rows = ports.store
      .statement("SELECT * FROM transfer_live_resume ORDER BY next_at LIMIT 64")
      .all()
      .map((raw) => Row.parse(raw));
    let next: number | undefined;
    for (const row of rows) {
      if (row.next_at > ports.now()) {
        next = Math.min(next ?? row.next_at, row.next_at);
        continue;
      }
      const status = ports.status(row.thread_id);
      // Gone, or already carrying on (the person, or its own queue, moved it on).
      if (!status || carryingOn.has(status.state)) {
        this.forget(row.thread_id);
        continue;
      }
      // Paused, limited or waiting: still owed, looked at again shortly. Never dropped for it.
      if (!atRest.has(status.state)) {
        const due = ports.now() + lookAgainMs;
        ports.store
          .statement("UPDATE transfer_live_resume SET next_at=? WHERE thread_id=?")
          .run(due, row.thread_id);
        next = Math.min(next ?? due, due);
        continue;
      }
      try {
        ports.send(
          row.thread_id,
          `transfer-live:${row.transfer_id}:resume:${row.attempts}`,
          row.text,
        );
        this.forget(row.thread_id);
      } catch (error) {
        const due = ports.now() + Math.min(1_000 * 2 ** row.attempts, maxWaitMs);
        ports.store
          .statement(
            "UPDATE transfer_live_resume SET attempts=attempts+1, next_at=? WHERE thread_id=?",
          )
          .run(due, row.thread_id);
        ports.log("Resume not sent yet", { threadId: row.thread_id, error: String(error) });
        next = Math.min(next ?? due, due);
      }
    }
    return rows.length === 64 ? ports.now() : next;
  }
  /** Keeps draining in the background until nothing is owed, waking for new debts. */
  start(): void {
    this.running ??= this.loop().finally(() => {
      this.running = undefined;
    });
  }
  kick(): void {
    this.wake.abort();
    this.start();
  }
  async close(): Promise<void> {
    this.stopped.abort();
    this.wake.abort();
    await this.running;
  }
  private async loop(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      this.wake = new AbortController();
      const next = this.drain();
      if (next === undefined) return;
      const signal = AbortSignal.any([this.wake.signal, this.stopped.signal]);
      await this.ports.sleep(Math.max(0, next - this.ports.now()), signal);
    }
  }
  private forget(threadId: string): void {
    this.ports.store.statement("DELETE FROM transfer_live_resume WHERE thread_id=?").run(threadId);
  }
}
