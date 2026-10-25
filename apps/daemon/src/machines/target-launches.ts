import { z } from "zod";
import { launchSlots } from "@ace/orchestrator";
import { Command, ThreadId, type Event } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { Engine } from "../engine/index.ts";
import { commandContext } from "../commands.ts";
import { controlAdmissionError, engineFull } from "../agent-control/failure.ts";
import {
  LaunchQueue,
  drainLaunches,
  startOrQueue,
  type QueuedLaunch,
} from "../agent-control/launch-queue.ts";

export interface TargetLaunchDeps {
  store: Store;
  engine(): Engine | undefined;
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
const Row = z.object({ role: z.string(), outcome: z.enum(["cancelled", "failed"]).nullable() });
const RETRY_MS = 1000;

/**
 * First runs of the children other machines delegate here. Each starts at once when its calling
 * thread has a free slot under this machine's limit and the engine has room; otherwise it waits,
 * durably and in order, in the same launch queue local delegations use, and starts when a slot
 * frees. A wait is never a refusal, and a child that never ran settles with a result.
 */
export class TargetLaunches {
  private deps: TargetLaunchDeps;
  private queue: LaunchQueue;
  private unsubscribe: () => void;
  private cancelTimer: (() => void) | undefined;
  private pumping = false;
  private closed = false;
  constructor(deps: TargetLaunchDeps) {
    this.deps = deps;
    this.queue = new LaunchQueue(deps.store, "machine_launch_queue");
    deps.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS machine_launches (
        thread_id TEXT PRIMARY KEY, role TEXT NOT NULL, outcome TEXT)`),
    );
    // A thread finishing frees its slot; the retry timer covers engine room freed elsewhere.
    this.unsubscribe = deps.store.subscribe((events: readonly Event[]) => {
      if (events.some((event) => event.payload.type === "thread.updated")) this.pump();
    });
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
    const state = store.atomic(() => {
      store
        .statement("INSERT OR IGNORE INTO machine_launches (thread_id,role) VALUES (?,?)")
        .run(input.threadId, input.role);
      const outcome = startOrQueue(this.queue, launch, this.slots(parent), () =>
        this.start(launch),
      );
      if (outcome === "queued")
        store.appendEvents(input.threadId, [
          { type: "thread.updated", queuedLaunch: { text: input.task } },
        ]);
      return outcome;
    });
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
    if (this.closed || this.pumping || !this.deps.engine() || !this.queue.waiting()) return;
    this.pumping = true;
    try {
      for (const parent of this.queue.parents())
        drainLaunches(
          this.deps.store,
          this.queue,
          parent,
          this.slots(parent),
          (launch) => this.start(launch),
          (child, error) => {
            this.deps.report(error);
            this.deps.store.atomic(() => this.settle(child, "failed"));
          },
        );
    } catch (error) {
      this.deps.report(error);
    } finally {
      this.pumping = false;
    }
    this.arm();
  }
  private row(threadId: ThreadId) {
    const raw = this.deps.store
      .statement("SELECT role,outcome FROM machine_launches WHERE thread_id=?")
      .get(threadId);
    return raw ? Row.parse(raw) : undefined;
  }
  private settle(threadId: ThreadId, outcome: "cancelled" | "failed") {
    const { store } = this.deps;
    store
      .statement("UPDATE machine_launches SET outcome=? WHERE thread_id=?")
      .run(outcome, threadId);
    if (store.getThread(threadId)?.queuedLaunch)
      store.appendEvents(threadId, [{ type: "thread.updated", queuedLaunch: null }]);
  }
  private slots(parent: string): number {
    const limit = this.deps.limit();
    return limit === undefined ? Infinity : launchSlots(this.running(parent), limit);
  }
  /** The calling thread's children here that hold a run slot: started and not yet finished. */
  private running(parent: string): number {
    const [device, host, thread] = Parent.parse(JSON.parse(parent));
    const { store } = this.deps;
    return store
      .statement(
        "SELECT thread_id FROM machine_threads WHERE kind='delegate' AND device_id=? AND origin_host=? AND origin_thread=?",
      )
      .all(device, host, thread)
      .map((row) => ThreadId.parse(row.thread_id))
      .filter((id) => {
        if (this.queue.has(id)) return false;
        const child = store.getThread(id);
        return (
          !!child &&
          child.deletedAt === undefined &&
          !["new", "done", "failed"].includes(child.status.state)
        );
      }).length;
  }
  private start(launch: QueuedLaunch) {
    const { store } = this.deps;
    const engine = this.deps.engine();
    if (!engine) throw controlAdmissionError("engine_starting");
    const thread = store.getThread(launch.childId);
    // A thread deleted while it waited has nothing left to start.
    if (!thread || thread.deletedAt !== undefined) return;
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
    });
  }
  /** Waiting children are retried each second, so a missed slot release only delays them. */
  private arm() {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.closed || !this.queue.waiting()) return;
    this.cancelTimer = this.deps.schedule(RETRY_MS, () => {
      this.cancelTimer = undefined;
      this.pump();
      this.arm();
    });
  }
}
