import { z } from "zod";
import { launchSlots } from "@ace/orchestrator";
import { Command, ThreadId, type Event, type Thread } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import type { DelegationJournal } from "../agent-control/journal.ts";
import { commandContext } from "../commands.ts";
import { controlAdmissionError, engineFull } from "../agent-control/failure.ts";
import { heldFor } from "../agent-control/watch-view.ts";
import {
  LaunchQueue,
  drainLaunches,
  startOrQueue,
  type QueuedLaunch,
} from "../agent-control/launch-queue.ts";

export interface TargetLaunchDeps {
  store: Store;
  engine(): Engine | undefined;
  /** Stop markers: a thread stopped here never starts its waiting task. */
  journal(): Pick<DelegationJournal, "stopped"> | undefined;
  /** This machine's running-children limit, read live; undefined is no limit. */
  limit(): number | undefined;
  /** Retry timers are the shell's; this owner never reaches for a clock. */
  schedule(ms: number, run: () => void): () => void;
  report(error: unknown): void;
}
/** The calling thread on another machine whose run slots a child here counts against. */
export interface LaunchParent {
  deviceId: string;
  hostId: string;
  threadId: string;
}
const Parent = z.tuple([z.string(), z.string(), z.string()]);
const Row = z.object({
  role: z.string(),
  outcome: z.enum(["cancelled", "failed"]).nullable(),
  active: z.number(),
});
const RETRY_MS = 1000;
const idleStates: ReadonlySet<string> = new Set(["new", "done", "failed"]);
const idle = (thread: Thread | undefined) =>
  !thread || thread.deletedAt !== undefined || idleStates.has(thread.status.state);

/**
 * First runs of the children other machines delegate here. Each starts at once when its calling
 * thread has a free slot under this machine's limit and the engine has room; otherwise it waits,
 * durably and in order, in the same launch queue local delegations use, and starts when a slot
 * frees. A wait is never a refusal, and a child that never ran settles with a result.
 *
 * Each child's row says whether it holds one of its calling thread's slots (`active`: started,
 * not finished, not held for the person), kept current as that child's status changes, so
 * counting a calling thread's running children is one indexed count and a pump runs only when
 * something may have freed a slot.
 */
export class TargetLaunches {
  private deps: TargetLaunchDeps;
  private queue: LaunchQueue;
  private unsubscribe: () => void;
  private cancelTimer: (() => void) | undefined;
  private pumping = false;
  private closed = false;
  /** The last start hit a full engine: retry as threads go idle, and on a timer. */
  private engineBlocked: boolean;
  constructor(deps: TargetLaunchDeps) {
    this.deps = deps;
    this.queue = new LaunchQueue(deps.store, "machine_launch_queue");
    deps.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS machine_child_launches (
        thread_id TEXT PRIMARY KEY, parent TEXT NOT NULL, role TEXT NOT NULL, outcome TEXT,
        active INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS machine_child_launches_active
        ON machine_child_launches(parent, active)`),
    );
    // Children that finished while the daemon was down give their slots back now.
    deps.store.atomic(() => {
      for (const row of deps.store
        .statement("SELECT thread_id FROM machine_child_launches WHERE active=1")
        .all())
        this.refresh(ThreadId.parse(row.thread_id));
    });
    this.unsubscribe = deps.store.subscribe((events) => this.observe(events));
    // After a restart nothing else announces the waiting children: try once the engine is up.
    this.engineBlocked = this.queue.waiting();
    this.arm();
  }
  close() {
    this.closed = true;
    this.unsubscribe();
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
  /**
   * Sends a prepared thread its task now, or queues it. `task` is what its thread shows while
   * it waits. Any failure other than a full engine is thrown for the caller to refuse.
   */
  launch(input: {
    threadId: ThreadId;
    parent: LaunchParent;
    role: string;
    text: string;
    task: string;
  }): "started" | "queued" {
    const { store } = this.deps;
    const parent = JSON.stringify([
      input.parent.deviceId,
      input.parent.hostId,
      input.parent.threadId,
    ]);
    const launch = { childId: input.threadId, parentId: parent, text: input.text };
    const slots = this.slots(parent);
    const state = store.atomic(() => {
      store
        .statement(
          "INSERT OR IGNORE INTO machine_child_launches (thread_id,parent,role) VALUES (?,?,?)",
        )
        .run(input.threadId, parent, input.role);
      const outcome = startOrQueue(this.queue, launch, slots, () => this.start(launch));
      if (outcome === "queued")
        store.appendEvents(input.threadId, [
          { type: "thread.updated", queuedLaunch: { text: input.task } },
        ]);
      return outcome;
    });
    // A free slot that still queued it means the engine is full.
    if (state === "queued" && slots > 0) this.engineBlocked = true;
    this.arm();
    return state;
  }
  queued(threadId: ThreadId): boolean {
    return this.queue.has(threadId);
  }
  /** How a child that never ran settled, if it did. */
  unlaunched(threadId: ThreadId): "cancelled" | "failed" | undefined {
    return this.row(threadId)?.outcome ?? undefined;
  }
  /** New work was admitted for the thread: how it settled before it ran no longer applies. */
  reopen(threadId: ThreadId): void {
    this.deps.store
      .statement("UPDATE machine_child_launches SET outcome=NULL WHERE thread_id=?")
      .run(threadId);
  }
  /** Stops a waiting child before it starts. False when it was not waiting. */
  cancel(threadId: ThreadId): boolean {
    return this.deps.store.atomic(() => {
      if (!this.queue.take(threadId)) return false;
      this.settle(threadId, "cancelled");
      return true;
    });
  }
  /**
   * The parent's own message to a waiting child starts it first, past the limit, as it does for
   * a local child. A full engine keeps it waiting; the message still goes in behind it.
   */
  startNow(threadId: ThreadId): void {
    try {
      this.deps.store.atomic(() => {
        const launch = this.queue.take(threadId);
        if (launch) this.start(launch);
      });
    } catch (error) {
      if (!engineFull(error)) throw error;
    }
  }
  /** Fills each calling thread's free slots from its waiting children, oldest first. */
  pump(): void {
    if (this.closed || this.pumping || !this.queue.waiting()) return;
    // Not up yet: the retry timer comes back once it is.
    if (!this.deps.engine()) return this.arm();
    this.pumping = true;
    let blocked = false;
    try {
      for (const parent of this.queue.parents())
        blocked =
          drainLaunches(
            this.deps.store,
            this.queue,
            parent,
            this.slots(parent),
            (launch) => this.start(launch),
            (child, error) => {
              // The failed start rolled back and left it queued: take it out with the failure,
              // in one transaction, so it reads failed and is never retried.
              this.deps.report(error);
              this.deps.store.atomic(() => {
                this.queue.take(child);
                this.settle(child, "failed");
              });
            },
          ) === "engine_full" || blocked;
    } catch (error) {
      this.deps.report(error);
    } finally {
      this.pumping = false;
    }
    this.engineBlocked = blocked;
    this.arm();
  }
  /**
   * Slots free when one of these children stops running. Engine room frees when any thread goes
   * idle, which matters only while a start is waiting on it.
   */
  private observe(events: readonly Event[]) {
    let freed = false;
    for (const event of events) {
      const type = event.payload.type;
      if (type !== "thread.updated" && type !== "run.started") continue;
      const row = this.row(event.threadId);
      // Any new run (the person's own message there, say) means it is no longer unlaunched.
      if (type === "run.started" && row?.outcome) this.reopen(event.threadId);
      if (row) freed = this.refresh(event.threadId) || freed;
      else if (this.engineBlocked && type === "thread.updated")
        freed = idle(this.deps.store.getThread(event.threadId)) || freed;
    }
    if (freed) this.pump();
  }
  /** Keeps the child's slot flag current. True when it just gave its slot back. */
  private refresh(threadId: ThreadId): boolean {
    const row = this.row(threadId);
    if (!row) return false;
    const thread = this.deps.store.getThread(threadId);
    // A started child may still read `new` until its run begins; it holds its slot meanwhile.
    const finished =
      !thread || thread.deletedAt !== undefined || ["done", "failed"].includes(thread.status.state);
    // A queue held for the person (after a Stop or a restart) runs nothing until someone acts,
    // so, as for a local child, it gives its slot to the next waiting one.
    const held =
      !!thread && heldFor(thread, undefined, this.deps.engine()?.resuming(threadId) ?? false);
    const active = finished || held || row.outcome || this.queue.has(threadId) ? 0 : 1;
    if (active === row.active) return false;
    this.deps.store
      .statement("UPDATE machine_child_launches SET active=? WHERE thread_id=?")
      .run(active, threadId);
    return active === 0;
  }
  private row(threadId: ThreadId) {
    const raw = this.deps.store
      .statement("SELECT role,outcome,active FROM machine_child_launches WHERE thread_id=?")
      .get(threadId);
    return raw ? Row.parse(raw) : undefined;
  }
  private settle(threadId: ThreadId, outcome: "cancelled" | "failed") {
    const { store } = this.deps;
    store
      .statement("UPDATE machine_child_launches SET outcome=?, active=0 WHERE thread_id=?")
      .run(outcome, threadId);
    if (store.getThread(threadId)?.queuedLaunch)
      store.appendEvents(threadId, [{ type: "thread.updated", queuedLaunch: null }]);
  }
  private slots(parent: string): number {
    const limit = this.deps.limit();
    if (limit === undefined) return Infinity;
    const running = Number(
      this.deps.store
        .statement("SELECT COUNT(*) AS n FROM machine_child_launches WHERE parent=? AND active=1")
        .get(parent)?.n,
    );
    return launchSlots(running, limit);
  }
  /** Sends the waiting task, or settles it cancelled when it may no longer run. */
  private start(launch: QueuedLaunch): "started" | "skipped" {
    const { store } = this.deps;
    const engine = this.deps.engine();
    if (!engine) throw controlAdmissionError("engine_starting");
    const thread = store.getThread(launch.childId);
    // A thread deleted while it waited has nothing left to start.
    if (!thread || thread.deletedAt !== undefined) return "skipped";
    // Stopped while it waited (or its Stop was missed): it settles cancelled, never runs.
    if (
      this.row(launch.childId)?.outcome === "cancelled" ||
      this.deps.journal()?.stopped(launch.childId)
    ) {
      this.settle(launch.childId, "cancelled");
      return "skipped";
    }
    const [deviceId] = Parent.parse(JSON.parse(launch.parentId));
    const role = this.row(launch.childId)?.role;
    store.atomic(() => {
      const command = Command.parse({
        id: `machine-launch:${launch.childId}`,
        deviceId,
        payload: {
          type: "thread.send",
          threadId: launch.childId,
          input: [{ type: "text", text: launch.text }],
          delivery: "queue",
          trigger: "spawn",
          origin: { kind: "spawn", ...(role ? { role } : {}) },
        },
      });
      const result = store.recordCommand(command.id, command.deviceId, () =>
        engine.internalHandler.handle(command, commandContext(store)),
      );
      if (!result.ok) throw controlAdmissionError(result.error ?? "Launch failed");
      if (store.getThread(launch.childId)?.queuedLaunch)
        store.appendEvents(launch.childId, [{ type: "thread.updated", queuedLaunch: null }]);
      // It holds its slot from now, before any status change reports it.
      store
        .statement("UPDATE machine_child_launches SET active=1 WHERE thread_id=?")
        .run(launch.childId);
    });
    return "started";
  }
  /** Only a start waiting on engine room is retried on a timer; slots announce themselves. */
  private arm() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.closed || !this.engineBlocked || !this.queue.waiting()) return;
    this.cancelTimer = this.deps.schedule(RETRY_MS, () => {
      this.cancelTimer = undefined;
      this.pump();
    });
  }
}
