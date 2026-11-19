import type { Fact } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { EngineClock, ThreadActor } from "./actor.ts";
import type { QueueHold, Recovery } from "./recovery.ts";
import type { RecoveryRecord } from "./queue-store.ts";
import type { EngineRepository } from "./repository.ts";
import type { Sessions } from "./sessions.ts";
import { resumable } from "./thread-liveness.ts";

export interface SettledTreePorts {
  repo: EngineRepository;
  clock: EngineClock;
  sessions: Sessions;
  recovery: Recovery;
  actor(id: ThreadId): ThreadActor | undefined;
  /** Every queued send, control and steer for the thread has finished. */
  drain(id: ThreadId): Promise<void>;
  /** Drop the engine's cached actor and state for a stopped thread. */
  forget(id: ThreadId): void;
  /** The thread and every delegated child it owns. */
  tree(id: ThreadId): ThreadId[];
}

/**
 * Settling says the person is done with a thread, so nothing it started keeps running: each
 * thread in its tree, children first, loses its provider session (and with it every background
 * task and shell it owns), its open questions and the inputs that need a live session. Messages
 * the person queued and results its own children sent stay, held, for when they come back:
 * nothing in a settled tree starts a turn by itself (`settledHold`).
 *
 * The stop is fenced by the settle itself. Once the person unsettles the thread or sends to it,
 * whatever is left of the stop does nothing, so their new turn is never cut off.
 *
 * A part that fails to stop goes to `failed` (the daemon's log), never to the person; the
 * thread keeps reading as it really is, and the next liveness sweep tries again.
 */
export class SettledTrees {
  private ports: SettledTreePorts;
  private flights = new Map<ThreadId, Promise<void>>();
  constructor(ports: SettledTreePorts) {
    this.ports = ports;
  }
  get active(): boolean {
    return this.flights.size > 0;
  }
  async settled(): Promise<void> {
    await Promise.allSettled(this.flights.values());
  }
  stop(id: ThreadId, failed: (thread: ThreadId, error: unknown) => void): Promise<void> {
    const running = this.flights.get(id);
    if (running) return running;
    const { repo } = this.ports;
    const settledAt = repo.store.getThread(id)?.settledAt;
    if (settledAt === undefined) return Promise.resolve();
    const mark = latestIntent(repo, id);
    const still = () =>
      repo.store.getThread(id)?.settledAt === settledAt && !newDelivery(repo, id, mark);
    const flight = (async () => {
      // Out of the settle event's own notification first.
      await Promise.resolve();
      for (const owner of this.ports.tree(id).toReversed()) {
        if (!still()) return;
        await this.stopOne(owner, still).catch((error: unknown) => failed(owner, error));
      }
    })()
      .catch((error: unknown) => failed(id, error))
      .finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }
  private async stopOne(id: ThreadId, still: () => boolean): Promise<void> {
    const { repo, sessions, clock } = this.ports;
    if (!repo.state(id)) return;
    const holdQueued = () => {
      const hold = settledHold(repo.queue.get(id), repo.queue.waitingSends(id));
      if (hold.paused)
        repo.queue.set(id, { ...hold, resumeAt: null, timerAction: null }, clock.now());
    };
    retireLiveIntents(repo, id);
    // In one write: a thread that read "waiting" for a moment would wake its parent's watch,
    // which revives the edge, settles it again and hands its result over a second time.
    this.ports.recovery.discardHolding(
      id,
      settledHold(repo.queue.get(id), repo.queue.waitingSends(id)),
    );
    const actor = this.ports.actor(id);
    actor?.lifetime?.abort();
    // A provider that won't exit keeps its session: the thread reads as it is until a retry.
    if (actor?.session) await sessions.close(actor, "user");
    await this.ports.drain(id);
    await actor?.flush();
    // Reopened meanwhile: the person's new work is left alone.
    if (!still()) return;
    // A session that finished opening during the stop closes too.
    if (actor?.session) await sessions.close(actor, "user");
    holdQueued();
    repo.apply(
      id,
      [
        ...Object.keys(repo.requireState(id).indexes.pendingInteractions).map(
          (interaction): Fact => ({ type: "interaction.closed", interaction, state: "cancelled" }),
        ),
        { type: "process.exited", deliberate: true },
        { type: "queue.changed", source: "provider", count: 0 },
        ...[repo.engineQueueFact(id)].filter((fact) => fact !== undefined),
      ],
      clock.now(),
    );
    this.ports.forget(id);
  }
}

/**
 * How a settle leaves a thread's queue. A send that failed (its checkout gone, its model
 * unavailable) or may have gone keeps that hold and its reason: it is not retried now, and it
 * still says why it waits. Anything else still to send, the person's messages
 * and child results alike, is held as stopped: sent, it would start a turn in a settled tree.
 * With nothing to send, the queue is released.
 */
export function settledHold(
  queue: Pick<RecoveryRecord, "paused" | "reason">,
  waitingSends: number,
): QueueHold {
  if (waitingSends === 0) return { paused: false, reason: null };
  if (queue.paused && queue.reason !== null && keptReasons.has(queue.reason))
    return { paused: true, reason: queue.reason };
  return { paused: true, reason: "stopped" };
}
const keptReasons: ReadonlySet<string> = new Set(["not_sent", "model_unavailable", "uncertain"]);

/** Inputs that need a live session end with it; queued sends wait for the thread's next run. */
function retireLiveIntents(repo: EngineRepository, id: ThreadId): void {
  repo.store.atomic(() => {
    for (const intent of repo.pending.headers(id)) {
      if (resumable.has(intent.kind)) continue;
      repo.mark(intent, "failed", "The thread was settled");
      repo.transitions.releaseGuards(intent.commandId);
    }
  });
}

function latestIntent(repo: EngineRepository, id: ThreadId): number {
  let latest = 0;
  for (const intent of repo.pending.headers(id)) latest = Math.max(latest, intent.id);
  return latest;
}

/** The person sent to the thread (or switched, merged, resumed it) after it was settled. */
function newDelivery(repo: EngineRepository, id: ThreadId, mark: number): boolean {
  for (const intent of repo.pending.headers(id))
    if (intent.id > mark && resumable.has(intent.kind) && intent.kind !== "thread.limit")
      return true;
  return false;
}
