import type { Fact } from "@ace/core";
import type { Thread, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { EngineClock, ThreadActor } from "./actor.ts";
import type { IntentWorkers } from "./workers.ts";
import type { Recovery } from "./recovery.ts";
import type { Sessions } from "./sessions.ts";
import { lostWork } from "./lost-work.ts";

/** Live engine work in a thread tree; durable records alone never count. */
export interface LiveWork {
  agentsRunning: number;
  operationsRunning: number;
}

export interface LivenessPorts {
  repo: EngineRepository;
  clock: EngineClock;
  maxThreads: number;
  sessions: Sessions;
  sends: IntentWorkers;
  controls: IntentWorkers;
  steering: IntentWorkers;
  recovery: Recovery;
  actor(id: ThreadId): ThreadActor | undefined;
  updateChild(parent: ThreadId, child: Thread): void;
}

/** Inputs that resume when their thread runs again; everything else needs a live session. */
const resumable = new Set([
  "thread.send",
  "thread.create",
  "thread.fork",
  "thread.switch",
  "thread.merge",
  "thread.resume",
  "queue.resume",
  "thread.limit",
]);

/**
 * Separates genuinely live work from records a dead provider left behind, and stops a
 * thread tree for deletion. Reads only bounded active state, never transcript history.
 */
export class ThreadLiveness {
  private ports: LivenessPorts;
  constructor(ports: LivenessPorts) {
    this.ports = ports;
  }
  /** The thread and every delegated child it owns, breadth first, bounded. */
  tree(id: ThreadId): ThreadId[] {
    const ids = new Set<ThreadId>([id]);
    for (const owner of ids) {
      const state = this.ports.repo.state(owner);
      for (const record of Object.values(state?.agents ?? {}))
        if (record.agent.childThreadId) ids.add(record.agent.childThreadId);
      if (ids.size > this.ports.maxThreads) throw new Error("Thread tree exceeds capacity");
    }
    return [...ids];
  }
  /** Children first, so a parent sees its children's settled statuses. */
  async reconcileTree(id: ThreadId): Promise<void> {
    const { repo } = this.ports;
    for (const owner of this.tree(id).toReversed()) {
      const state = repo.state(owner);
      if (!state) continue;
      for (const record of Object.values(state.agents)) {
        const childId = record.agent.childThreadId;
        const child = childId && repo.store.getThread(childId);
        if (child && JSON.stringify(record.externalStatus) !== JSON.stringify(child.status))
          this.ports.updateChild(owner, child);
      }
      await this.reconcile(owner);
    }
  }
  /** One thread. A live session is authoritative and costs no state read. */
  async reconcile(id: ThreadId): Promise<void> {
    const { repo, sessions, sends, steering } = this.ports;
    const actor = this.ports.actor(id);
    if (actor?.session) return;
    await actor?.flush();
    if (
      actor?.session ||
      sessions.isClosing(id) ||
      repo.sessionOpening(id) ||
      sends.isActive(id) ||
      steering.isActive(id)
    )
      return;
    reconcileStoppedThread(repo, id, this.ports.clock.now());
    actor?.syncQueue();
  }
  live(id: ThreadId): LiveWork {
    const { repo, sessions } = this.ports;
    let agentsRunning = 0;
    let operationsRunning = 0;
    for (const owner of this.tree(id)) {
      const state = repo.state(owner);
      if (this.ports.actor(owner)?.session && state && !repo.quiescent(state))
        agentsRunning += Math.max(
          1,
          Object.values(state.agents).filter(
            (record) =>
              !record.externalStatus &&
              !["idle", "interrupted", "failed"].includes(record.agent.status.state),
          ).length,
        );
      const queue = repo.queue.get(owner);
      if (
        sessions.isClosing(owner) ||
        repo.sessionOpening(owner) ||
        repo.pending.running(owner) ||
        (!queue.paused &&
          !queue.limited &&
          (repo.pending.message(owner) || repo.pending.recovery(owner)))
      )
        operationsRunning++;
    }
    return { agentsRunning, operationsRunning };
  }
  /** Called after the durable cleanup fence has denied all new execution. */
  async stop(id: ThreadId): Promise<void> {
    const { repo, sessions, clock } = this.ports;
    if (!repo.state(id)) return;
    this.ports.recovery.discard(id);
    retireThreadIntents(repo, id, clock.now(), "Retired for thread deletion");
    const actor = this.ports.actor(id);
    actor?.lifetime?.abort();
    if (actor) await sessions.close(actor, "user");
    await Promise.all([
      this.ports.sends.drain(id),
      this.ports.controls.drain(id),
      this.ports.steering.drain(id),
    ]);
    await actor?.flush();
    // Opening can finish during cancellation. Close that session as well.
    if (actor?.session) await sessions.close(actor, "user");
    repo.apply(
      id,
      [
        ...Object.keys(repo.requireState(id).indexes.pendingInteractions).map(
          (interaction): Fact => ({ type: "interaction.closed", interaction, state: "cancelled" }),
        ),
        { type: "process.exited", deliberate: true },
        { type: "queue.changed", source: "provider", count: 0 },
        { type: "queue.changed", source: "engine", count: 0 },
      ],
      clock.now(),
    );
    actor?.stop();
    repo.release(id);
  }
}

/** A thread with no running session: settle what its dead provider left behind. */
export function reconcileStoppedThread(repo: EngineRepository, id: ThreadId, at: number): void {
  const state = repo.state(id);
  if (!state) return;
  repo.store.atomic(() => {
    if (!state.processExit && lostWork(state)) {
      repo.apply(
        id,
        [
          { type: "process.exited", deliberate: false, message: "The agent stopped unexpectedly" },
          { type: "queue.changed", source: "provider", count: 0 },
          unexpectedStopNotice(state.rootKey, at),
        ],
        at,
      );
    }
    for (const intent of repo.pending.headers(id)) {
      if (resumable.has(intent.kind)) continue;
      repo.mark(intent, "failed", "Owning provider session is no longer running");
      repo.transitions.releaseGuards(intent.commandId);
    }
    const count = repo.queuedCount(id);
    if (state.queueSources.engine !== count)
      repo.apply(id, [{ type: "queue.changed", source: "engine", count }], at);
  });
}

/** Explicit deletion discards held inputs; ordinary liveness checks preserve resumable sends. */
export function retireThreadIntents(
  repo: EngineRepository,
  id: ThreadId,
  at: number,
  reason: string,
): void {
  repo.store.atomic(() => {
    for (const intent of repo.pending.headers(id)) {
      repo.mark(intent, "failed", reason);
      repo.queue.clearUncertain(intent.id);
      repo.transitions.releaseGuards(intent.commandId);
    }
    const uncertain = repo.store
      .statement("SELECT id FROM intents WHERE thread_id=? AND uncertain=1")
      .all(id);
    for (const row of uncertain) {
      if (typeof row.id !== "number") throw new Error("Invalid intent identity");
      repo.queue.clearUncertain(row.id);
      repo.queue.prune(row.id);
    }
    repo.apply(id, [{ type: "queue.changed", source: "engine", count: 0 }], at);
  });
}

/** One transcript notice per unexpected stop, so a second stop is not folded into the first. */
export function unexpectedStopNotice(agent: string | undefined, at: number): Fact {
  return {
    type: "item.upsert",
    agent: agent ?? "root",
    item: `liveness:stopped:${at}`,
    draft: {
      type: "notice",
      level: "warning",
      code: "agent_stopped",
      text: "The agent stopped unexpectedly",
      complete: true,
    },
  };
}
