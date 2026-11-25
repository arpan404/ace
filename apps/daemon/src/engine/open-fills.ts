import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store.ts";

/**
 * Opening a home does schema setup only (ADR 0170). The data passes that used to run at open are
 * fills: idle, bounded, resumable passes started after construction, with a reader rule that is
 * correct before they complete. This module is the driver and the durable progress they share.
 */

/** The most rows one step reads or writes. */
export const fillBatch = 256;

/** One bounded, resumable data pass. */
export interface OpenFill {
  readonly name: string;
  /** One step; true when it made progress (including one that only advanced its cursor). */
  step(): boolean;
  /** Whether the pass has nothing left to do. */
  complete(): boolean;
}

/**
 * Schedules one idle tick after `delayMs`; the returned function cancels it. Injected so a test
 * drives the tick with its own clock.
 */
export type FillSchedule = (task: () => void, delayMs: number) => () => void;

/** A zero-delay timeout yields to I/O between steps, so a fill never holds the main thread. */
const idleTick: FillSchedule = (task, delayMs) => {
  const handle = setTimeout(task, delayMs);
  return () => clearTimeout(handle);
};

/** A failing fill retries from this delay, doubling to the cap; it is never abandoned. */
const retryFloorMs = 250;
const retryCeilingMs = 30_000;

const createFillsTable = `CREATE TABLE IF NOT EXISTS engine_open_fills (
  name TEXT PRIMARY KEY, cursor TEXT, done INTEGER NOT NULL DEFAULT 0
)`;

/** Creates the side table an older build ignores, before any durable fill reads its cursor. */
export function ensureOpenFillsTable(store: Store): void {
  store.atomic((db) => db.exec(createFillsTable));
}

const saveFill =
  "INSERT INTO engine_open_fills(name,cursor,done) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor, done=excluded.done";

/**
 * A fill whose result is durable: its cursor and `done` live beside the data in
 * `engine_open_fills`, written in the same transaction as the step's rows. Its progress is
 * applied only when that transaction commits, so a rollback redoes the step.
 */
export abstract class DurableFill implements OpenFill {
  readonly name: string;
  private store: Store;
  private cursor: string | undefined;
  private finished = false;
  constructor(store: Store, name: string) {
    this.store = store;
    this.name = name;
    const row = store.atomic((db) =>
      db.prepare("SELECT cursor,done FROM engine_open_fills WHERE name=?").get(name),
    );
    if (row) {
      this.cursor = row.cursor == null ? undefined : String(row.cursor);
      this.finished = row.done === 1;
    }
  }
  /**
   * The page after `cursor`: the step's rows, the next cursor, and whether it was the last page.
   * Runs inside the step's transaction, so its rows and the saved cursor commit together.
   */
  protected abstract page(
    db: DatabaseSync,
    cursor: string | undefined,
  ): { next: string | undefined; done: boolean };
  step(): boolean {
    if (this.finished) return false;
    const from = this.cursor;
    let next = from;
    let done = false;
    this.store.atomic(
      (db) => {
        const page = this.page(db, from);
        next = page.next;
        done = page.done;
        db.prepare(saveFill).run(this.name, page.next ?? null, page.done ? 1 : 0);
      },
      {
        // The events this step appended publish in this pass like any other commit's.
        publishesOwn: true,
        committed: () => {
          this.cursor = next;
          this.finished = done;
        },
        rolledBack: () => {},
      },
    );
    return true;
  }
  complete(): boolean {
    return this.finished;
  }
}

/**
 * One driver per engine: one step per idle tick, round-robin, yielding to I/O in between. A step
 * that throws is reported and retried with backoff; a fill is never abandoned, so a transient
 * store failure cannot strand the readers that wait on it.
 */
export class OpenFills {
  private readonly fills: OpenFill[];
  private readonly byName: Map<string, OpenFill>;
  private schedule: FillSchedule = idleTick;
  private cancel: (() => void) | undefined;
  private stopped = false;
  private started = false;
  private next = 0;
  /** Consecutive failed steps per fill; cleared by a step that works. */
  private readonly failures = new Map<OpenFill, number>();
  /** Callers waiting on one fill: true when it completes, false when it fails or stops. */
  private readonly waiters = new Map<string, ((done: boolean) => void)[]>();
  private settle: (() => void) | undefined;
  readonly completed: Promise<void>;
  private readonly report: (error: unknown) => void;
  constructor(store: Store, fills: OpenFill[], report: (error: unknown) => void = () => {}) {
    ensureOpenFillsTable(store);
    this.fills = fills;
    this.byName = new Map(fills.map((fill) => [fill.name, fill]));
    this.report = report;
    this.completed = new Promise((resolve) => (this.settle = resolve));
  }
  /** How a test drives the tick with its own clock instead of a timer. */
  useSchedule(schedule: FillSchedule): void {
    this.schedule = schedule;
  }
  /** Whether fill `name` has nothing left to do. */
  complete(name: string): boolean {
    return this.byName.get(name)?.complete() ?? true;
  }
  /** The threads a fill still has to reach, for a reader that must wait for one. */
  fill(name: string): OpenFill | undefined {
    return this.byName.get(name);
  }
  /**
   * Says when fill `name` is done: true once it completes, false if a step fails or the driver
   * stops first. A caller that needs the data now uses the false answer to take the slower path.
   */
  whenComplete(name: string): Promise<boolean> {
    if (this.complete(name)) return Promise.resolve(true);
    const fill = this.byName.get(name);
    // Nothing will complete it: the driver never started here, or it has stopped.
    if (!fill || !this.started || this.stopped) return Promise.resolve(false);
    if ((this.failures.get(fill) ?? 0) > 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiting = this.waiters.get(name) ?? [];
      waiting.push(resolve);
      this.waiters.set(name, waiting);
    });
  }
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.cancel = this.schedule(() => this.tick(), 0);
  }
  /** One bounded step. Tests drive the same step the idle tick does. */
  pump(): boolean {
    const active = this.fills.filter((fill) => !fill.complete());
    if (!active.length) {
      this.finish();
      return false;
    }
    let attempted = false;
    const start = this.next;
    for (let offset = 0; offset < active.length; offset++) {
      const fill = active[(start + offset) % active.length];
      if (!fill) continue;
      try {
        const worked = fill.step();
        this.failures.delete(fill);
        if (fill.complete()) this.settled(fill.name, true);
        // One successful step per tick keeps each blocking window bounded; the next tick
        // starts at the fill after it.
        if (worked) {
          this.next = (start + offset + 1) % active.length;
          return true;
        }
      } catch (error) {
        attempted = true;
        this.failures.set(fill, (this.failures.get(fill) ?? 0) + 1);
        // Reported, and a caller waiting on this fill takes its slower path. The other fills
        // still take their turn: a failed step wrote nothing, so it costs no rows.
        this.report(error);
        this.settled(fill.name, false);
      }
    }
    return attempted;
  }
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = undefined;
    for (const [name] of this.waiters) this.settled(name, false);
    this.settle?.();
  }
  private settled(name: string, done: boolean): void {
    const waiting = this.waiters.get(name);
    if (!waiting) return;
    this.waiters.delete(name);
    for (const resolve of waiting) resolve(done);
  }
  /** The wait before the next tick: none after progress, doubling while steps keep failing. */
  private retryDelay(): number {
    const worst = Math.max(0, ...this.failures.values());
    return worst === 0 ? 0 : Math.min(retryCeilingMs, retryFloorMs * 2 ** (worst - 1));
  }
  private tick(): void {
    this.cancel = undefined;
    if (this.stopped) return;
    const attempted = this.pump();
    if (this.stopped) return;
    if (!this.fills.some((fill) => !fill.complete())) {
      this.finish();
      return;
    }
    // No step ran and nothing failed: a fill is waiting to be asked, and `resume` restarts it.
    if (!attempted && this.retryDelay() === 0) return;
    this.cancel = this.schedule(() => this.tick(), this.retryDelay());
  }
  private finish(): void {
    this.cancel?.();
    this.cancel = undefined;
    if (this.fills.some((fill) => !fill.complete())) return;
    for (const [name] of this.waiters) this.settled(name, true);
    this.settle?.();
  }
}
