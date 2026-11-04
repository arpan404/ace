import type { HostId, MachineThreadView, RemoteContact, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import { REMOTE_CHILD_LEASE_MS } from "../liveness/lease.ts";
import { standing } from "../liveness/standing.ts";
import { REMOTE_STOP, type StopPlan } from "../liveness/stop.ts";
import { savedView, type ChildLedger, type ChildRow } from "./child-ledger.ts";
import type { ChildResults } from "./child-results.ts";
import {
  outcomeOf,
  unconfirmableView,
  unconfirmedView,
  type Unconfirmable,
} from "./child-views.ts";
import type { RequestMirror } from "./mirror.ts";
import { refusedNotFound } from "./transport.ts";

/** How many lapsed children one poll marks lost; the rest go on the next. */
const LAPSED_PER_POLL = 64;
/** After the bounded stop, the cancel still goes out this often until its machine confirms. */
const CONFIRM_RETRY_MS = 60_000;
/** How many unconfirmed stops one tick sends the cancel to again; the rest go on the next. */
const CONFIRM_PER_TICK = 16;

export interface ChildLivenessDeps {
  store: Store;
  ledger: ChildLedger;
  engine(): Engine | undefined;
  now(): number;
  schedule(ms: number, run: () => void): () => void;
  /** Sends one cancel to the child's machine. A failure is only logged: the stop goes on. */
  cancel(row: ChildRow): Promise<void>;
  /**
   * True once the child's pairing is gone (unpaired, or linked again as another device): its
   * stop can never be confirmed. False when the pairings can't be read.
   */
  unpaired(row: ChildRow): boolean;
  label(machine: string): string;
  host?(machine: string): HostId | undefined;
  results: ChildResults;
  mirror: RequestMirror;
  emit(ids: readonly string[]): void;
  log(message: string, fields: Record<string, unknown>): void;
  /** Overrides for tests; the defaults are the ADR's. */
  stopPlan?: StopPlan<"cancel"> | undefined;
  leaseMs?: number | undefined;
  confirmRetryMs?: number | undefined;
}

/**
 * Stop and proof of life for children on other machines (ADR 0052, "Stop and proof of life"),
 * the I/O around the pure rules in `liveness/`. A Stop sends the cancel, sends it again with
 * backoff while the child's machine hasn't reported it ended, and then settles it here as
 * stopped, saying its machine didn't confirm. A child its machine stops reporting for a lease is
 * lost contact: its parent's hold ends, and it resumes if it reports again.
 */
export class ChildLiveness {
  private deps: ChildLivenessDeps;
  private plan: StopPlan<"cancel">;
  private leaseMs: number;
  private confirmRetryMs: number;
  /** Leases count from here at the earliest: time this daemon wasn't running isn't silence. */
  private bootAt: number;
  private timer: { at: number; cancel: () => void } | undefined;
  private closed = false;
  constructor(deps: ChildLivenessDeps) {
    this.deps = deps;
    this.plan = deps.stopPlan ?? REMOTE_STOP;
    this.leaseMs = deps.leaseMs ?? REMOTE_CHILD_LEASE_MS;
    this.confirmRetryMs = deps.confirmRetryMs ?? CONFIRM_RETRY_MS;
    this.bootAt = deps.now();
  }
  close() {
    this.closed = true;
    this.timer?.cancel();
    this.timer = undefined;
  }
  /** Stops the child: final, bounded. False when there is nothing left to stop. */
  stop(id: ThreadId): boolean {
    const row = this.deps.ledger.row(id);
    if (!row || row.settled === 1) return false;
    if (!this.deps.ledger.startStop(id, this.deps.now())) return true;
    // Requests it had open there are no longer the person's to answer.
    this.deps.mirror.release(`child:${id}`);
    this.deps.emit([id]);
    this.tick();
    return true;
  }
  /** True while a stop of this child is under way. */
  stopping(row: ChildRow): boolean {
    return row.settled === 0 && row.stop_started_at !== null;
  }
  /**
   * Runs every stop that is due, settling each that ran out unconfirmed, and arms the next.
   * Read again after a restart, a stop past its bound gives up at once.
   */
  tick(): void {
    if (this.closed) return;
    const now = this.deps.now();
    let next: number | undefined;
    for (const row of this.deps.ledger.stopping()) {
      const at = this.standingOf(row, now);
      if (at.kind === "stopped_unconfirmed") {
        this.giveUp(row);
        continue;
      }
      if (at.kind !== "stopping") continue;
      if (at.next.kind === "wait") {
        next = Math.min(next ?? at.next.until, at.next.until);
        continue;
      }
      this.sendCancel(row, now);
      const step = this.plan[at.next.step] ?? this.plan[0];
      next = Math.min(next ?? now + step.waitMs, now + step.waitMs);
    }
    // Settled here unconfirmed: the cancel keeps going out, across reconnects and restarts (the
    // ledger keeps when it last went), until its machine reports the child ended. An offline
    // machine is retried; one no longer paired never can confirm, so ace stops asking.
    for (const row of this.deps.ledger.unconfirmedStops(CONFIRM_PER_TICK)) {
      if (this.deps.unpaired(row)) {
        this.unconfirmable(row, "unpaired");
        continue;
      }
      const due = (row.stop_last_at ?? 0) + this.confirmRetryMs;
      if (due <= now) this.sendCancel(row, now);
      const after = due <= now ? now + this.confirmRetryMs : due;
      next = Math.min(next ?? after, after);
    }
    this.arm(next);
  }
  private sendCancel(row: ChildRow, now: number): void {
    this.deps.ledger.stopAttempted(row.id, now);
    void this.deps.cancel(row).catch((error: unknown) => {
      // Its machine has no such child: the stop can never be confirmed there.
      if (row.stopped_unconfirmed === 1 && refusedNotFound(error))
        return this.unconfirmable(row, "gone");
      this.deps.log("Machine child cancel not confirmed", { id: row.id, error: String(error) });
    });
  }
  /**
   * A child stopped here whose stop can never be confirmed: its cancel stops going out, and it
   * reads cancelled, saying why, instead of cancelling.
   */
  private unconfirmable(row: ChildRow, why: Unconfirmable): void {
    if (this.closed) return;
    const name = this.deps.label(row.machine);
    const view = unconfirmableView(row, name, why, this.deps.now());
    const changed = this.deps.store.atomic(() => {
      if (!this.deps.ledger.markStopUnconfirmable(row.id, JSON.stringify(view))) return false;
      this.parentRow(row, name, undefined, undefined, view);
      return true;
    });
    if (!changed) return;
    this.deps.emit([row.id]);
    this.deps.log("Machine child stop can't be confirmed", {
      id: row.id,
      machine: row.machine,
      why,
    });
  }
  /**
   * The lease check: every unsettled child whose machine hasn't reported it within the lease is
   * lost contact, and its parent's hold on it ends.
   */
  lapse(): void {
    if (this.closed) return;
    const now = this.deps.now();
    // Nothing has had a whole lease to report since this daemon started.
    if (now - this.bootAt < this.leaseMs) return;
    for (const row of this.deps.ledger.lapsed(now - this.leaseMs, LAPSED_PER_POLL)) {
      const renewedAt = Math.max(row.seen_at ?? row.created_at, this.bootAt);
      const at = standing({ ended: false, lease: { renewedAt, ttlMs: this.leaseMs } }, now);
      if (at.kind !== "lost") continue;
      const name = this.deps.label(row.machine);
      this.deps.store.atomic(() => {
        this.deps.ledger.markSilent(row.id, at.since);
        this.parentRow(row, name, "lost", "lost");
      });
      this.deps.mirror.release(`child:${row.id}`);
      this.deps.emit([row.id]);
      this.deps.log("Machine child lost contact", { id: row.id, machine: row.machine });
    }
  }
  /**
   * Its machine reported it: the lease renews, and a child that had lost contact resumes, its
   * parent holding it again until it ends.
   */
  seen(row: ChildRow): ChildRow {
    const now = this.deps.now();
    if (row.silent_since === null) {
      // One write a tenth of a lease at most, not one per poll.
      if (now - (row.seen_at ?? 0) >= this.leaseMs / 10) this.deps.ledger.seen(row.id, now);
      return row;
    }
    const name = this.deps.label(row.machine);
    this.deps.store.atomic(() => {
      this.deps.ledger.seen(row.id, now);
      this.parentRow(row, name, undefined, "start");
    });
    this.deps.emit([row.id]);
    return { ...row, seen_at: now, silent_since: null };
  }
  /**
   * A settled child stopped here without confirmation, read again: how it really ended there is
   * recorded, but a child still working or waiting there is never live here again.
   */
  late(row: ChildRow, view: MachineThreadView, settled: boolean): void {
    if (!settled) return;
    if (row.stopped_unconfirmed === 1) {
      // Confirmed at last: its cancel stops going out and its parent no longer reads it unvouched.
      const name = this.deps.label(row.machine);
      this.deps.store.atomic(() => {
        this.deps.ledger.confirmStop(row.id, JSON.stringify(view));
        this.parentRow(row, name, undefined, undefined, view);
      });
    } else if (savedView(row)?.contact === "unconfirmed")
      this.deps.ledger.recordLateEnd(row.id, JSON.stringify(view));
    else return;
    this.deps.emit([row.id]);
  }
  private standingOf(row: ChildRow, now: number) {
    return standing(
      {
        ended: false,
        lease: { renewedAt: row.seen_at ?? row.created_at, ttlMs: this.leaseMs },
        stop: {
          plan: this.plan,
          progress: {
            startedAt: row.stop_started_at ?? now,
            attempts: row.stop_attempts,
            lastAttemptAt: row.stop_last_at,
          },
        },
      },
      now,
    );
  }
  /** Every cancel went out and its machine never said it ended: stopped here, saying so. */
  private giveUp(row: ChildRow): void {
    const now = this.deps.now();
    const name = this.deps.label(row.machine);
    const view = unconfirmedView(row, name, now);
    this.deps.store.atomic(() => {
      this.deps.ledger.markStoppedUnconfirmed(row.id, JSON.stringify(view), now);
      const stopped = this.deps.ledger.row(row.id) ?? row;
      this.parentRow(stopped, name, "unconfirmed", "end", view);
      this.deps.results.queueResult(stopped, view);
    });
    this.deps.mirror.release(`child:${row.id}`);
    this.deps.emit([row.id]);
    this.deps.log("Machine child stopped without confirmation", {
      id: row.id,
      machine: row.machine,
    });
  }
  /** The child's row in its parent, with the parent's hold changed as `hold` says. */
  private parentRow(
    row: ChildRow,
    name: string,
    contact: RemoteContact | undefined,
    hold: "start" | "end" | "lost" | undefined,
    ended?: MachineThreadView,
  ): void {
    const saved = savedView(row);
    const working = { state: "working" as const, agents: 1 };
    this.deps.engine()?.machineChild(
      {
        id: row.id,
        parentId: row.parent_thread,
        parentAgentId: row.parent_agent,
        machine: row.machine,
        name,
        hostId: this.deps.host?.(row.machine),
        provider: row.provider,
        model: row.model ?? undefined,
        role: row.role,
        title: saved?.title || row.role,
        status:
          ended?.status ?? (hold === "start" ? (saved?.status ?? working) : { state: "done" }),
        state: ended?.state ?? (hold === "start" ? (saved?.state ?? "working") : "failed"),
        outcome: ended
          ? {
              threadId: row.id,
              // How it ended there: a stop confirmed late may have finished or failed first.
              outcome: outcomeOf(ended.state),
              ...(ended.failure ? { failure: ended.failure } : {}),
              result: ended.result ?? "",
              truncated: false,
              before: null,
            }
          : null,
        contact,
      },
      hold,
    );
  }
  private arm(at: number | undefined): void {
    if (this.closed || at === undefined) return;
    if (this.timer && this.timer.at <= at) return;
    this.timer?.cancel();
    const delay = Math.max(0, at - this.deps.now());
    const cancel = this.deps.schedule(delay, () => {
      this.timer = undefined;
      try {
        this.tick();
      } catch (error) {
        this.deps.log("Machine child stops not checked", { error: String(error) });
        this.arm(this.deps.now() + (this.plan[0].waitMs || 1_000));
      }
    });
    this.timer = { at, cancel };
  }
}
