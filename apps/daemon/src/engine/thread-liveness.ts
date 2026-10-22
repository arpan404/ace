import type { Fact } from "@ace/core";
import type { Thread, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";
import type { EngineClock, ThreadActor } from "./actor.ts";
import type { IntentWorkers } from "./workers.ts";
import type { Recovery } from "./recovery.ts";
import type { Sessions } from "./sessions.ts";
import { lostWork } from "./lost-work.ts";
import { settleSessionBoundTasks } from "./session-bound-tasks.ts";
import { threadAttention } from "@ace/projection";

/** Live engine work in a thread tree; durable records alone never count. */
export interface LiveWork {
  agentsRunning: number;
  operationsRunning: number;
}

export interface LivenessPorts {
  repo: EngineRepository;
  clock: EngineClock;
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
  private settling = new Map<ThreadId, Promise<void>>();
  constructor(ports: LivenessPorts) {
    this.ports = ports;
  }
  /**
   * The thread and every delegated child it owns, breadth first. Delegation has no lifetime
   * child count, so this walks the whole tree; each thread is visited once.
   */
  tree(id: ThreadId): ThreadId[] {
    const ids = new Set<ThreadId>([id]);
    for (const owner of ids) {
      const state = this.ports.repo.state(owner);
      for (const record of Object.values(state?.agents ?? {}))
        if (record.agent.childThreadId) ids.add(record.agent.childThreadId);
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
    if (reconcileStoppedThread(repo, id, this.ports.clock.now()))
      this.ports.recovery.holdInterrupted(id);
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
  stop(id: ThreadId): Promise<void> {
    return this.stopOwned(id, () => {});
  }
  /** Idle retained sessions need cleanup, but have no unfinished outcome to cancel. */
  unfinished(id: ThreadId): boolean {
    const { repo } = this.ports;
    const thread = repo.store.getThread(id);
    if (!thread) return false;
    const queue = repo.queue.snapshot(id);
    return (
      !["done", "failed"].includes(thread.status.state) ||
      (queue.pendingCount ?? 0) > 0 ||
      queue.messages.some((message) => message.state === "uncertain") ||
      threadAttention({ queue }) !== undefined ||
      repo.pending.running(id) ||
      repo.sessionOpening(id)
    );
  }
  /**
   * A settled thread's whole tree stops, children first. A part that fails to stop never keeps
   * the rest running; it goes to `failed` (the daemon's log), never to the person.
   */
  settleTree(id: ThreadId, failed: (thread: ThreadId, error: unknown) => void): Promise<void> {
    const running = this.settling.get(id);
    if (running) return running;
    const flight = (async () => {
      // Out of the settle event's own notification first.
      await Promise.resolve();
      for (const owner of this.tree(id).toReversed())
        await this.stopSettled(owner).catch((error: unknown) => failed(owner, error));
    })()
      .catch((error: unknown) => failed(id, error))
      .finally(() => this.settling.delete(id));
    this.settling.set(id, flight);
    return flight;
  }
  /** Every settled tree still stopping has finished. */
  async settled(): Promise<void> {
    await Promise.allSettled(this.settling.values());
  }
  /**
   * Settling ends a thread's work for good: its provider session (and with it every background
   * task and shell it owns), questions still open, and inputs that need a live session. Messages
   * the person queued stay, held, for when they come back.
   */
  stopSettled(id: ThreadId): Promise<void> {
    const { repo, clock } = this.ports;
    if (!repo.state(id)) return Promise.resolve();
    const holdQueued = () => {
      if (repo.queue.count(id) > 0)
        repo.queue.set(
          id,
          { paused: true, reason: "stopped", resumeAt: null, timerAction: null },
          clock.now(),
        );
    };
    return this.stopOwned(id, holdQueued, () => retireLiveIntents(repo, id));
  }
  stopCancelled(id: ThreadId): Promise<void> {
    if (!this.unfinished(id)) return this.stop(id);
    if (!this.ports.repo.state(id)) return Promise.resolve();
    const markCancelled = () => {
      const { repo, clock } = this.ports;
      repo.queue.set(
        id,
        { paused: true, reason: "stopped", resumeAt: null, timerAction: null },
        clock.now(),
      );
      repo.queue.set(
        id,
        { lastFailure: { code: "cancelled", title: "Work cancelled by kill-all" } },
        clock.now(),
      );
    };
    return this.stopOwned(id, markCancelled);
  }
  private async stopOwned(
    id: ThreadId,
    beforeExit: () => void,
    retire: () => void = () =>
      retireThreadIntents(
        this.ports.repo,
        id,
        this.ports.clock.now(),
        "Retired for thread deletion",
      ),
  ): Promise<void> {
    const { repo, sessions, clock } = this.ports;
    if (!repo.state(id)) return;
    this.ports.recovery.discard(id);
    retire();
    // Session close can publish terminal facts before the final cleanup fold.
    beforeExit();
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
    beforeExit();
    repo.apply(
      id,
      [
        ...Object.keys(repo.requireState(id).indexes.pendingInteractions).map(
          (interaction): Fact => ({ type: "interaction.closed", interaction, state: "cancelled" }),
        ),
        { type: "process.exited", deliberate: true },
        { type: "queue.changed", source: "provider", count: 0 },
        // Deletion retired every queued input; settling keeps the person's queued messages.
        ...[repo.engineQueueFact(id)].filter((fact) => fact !== undefined),
      ],
      clock.now(),
    );
    actor?.stop();
    repo.release(id);
  }
}

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

/**
 * A thread with no running session: settle what its dead provider left behind. True when that
 * interrupted work, so the caller holds the thread for the person.
 */
export function reconcileStoppedThread(repo: EngineRepository, id: ThreadId, at: number): boolean {
  const state = repo.state(id);
  if (!state) return false;
  return repo.store.atomic(() => {
    const interrupted = !state.processExit && lostWork(state, 0, undefined, at) !== undefined;
    if (interrupted) {
      repo.apply(
        id,
        [
          { type: "process.exited", deliberate: false, message: "The agent stopped unexpectedly" },
          { type: "queue.changed", source: "provider", count: 0 },
          interruptedNotice(state.rootKey, at, "exit"),
        ],
        at,
      );
    }
    const stale = settleSessionBoundTasks(repo, state);
    if (stale.length) repo.apply(id, stale, at);
    for (const intent of repo.pending.headers(id)) {
      if (resumable.has(intent.kind)) continue;
      repo.mark(intent, "failed", "Owning provider session is no longer running");
      repo.transitions.releaseGuards(intent.commandId);
    }
    const fact = repo.engineQueueFact(id);
    if (fact) repo.apply(id, [fact], at);
    return interrupted;
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

/**
 * One transcript notice per interruption, so a second one is not folded into the first. A
 * daemon restart reads "Interrupted by a restart"; a provider that died on its own reads as an
 * unexpected stop. Either way the turn is held until the person resumes it.
 */
export function interruptedNotice(
  agent: string | undefined,
  at: number,
  cause: "restart" | "exit",
): Fact {
  return {
    type: "item.upsert",
    agent: agent ?? "root",
    item: `liveness:stopped:${at}`,
    draft: {
      type: "notice",
      level: "warning",
      code: cause === "restart" ? "restart_interrupted" : "agent_stopped",
      text: cause === "restart" ? "Interrupted by a restart" : "The agent stopped unexpectedly",
      complete: true,
    },
  };
}
