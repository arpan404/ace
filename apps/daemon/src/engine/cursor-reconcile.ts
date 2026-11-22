import type { Fact } from "@ace/core";
import type { ThreadId } from "@ace/protocol";
import type { ThreadActor, EngineClock } from "./actor.ts";
import type { EngineRepository } from "./repository.ts";
import type { Recovery } from "./recovery.ts";
import { interruptedNotice } from "./thread-liveness.ts";
import { lostWork } from "./lost-work.ts";
import { unconfirmed } from "./cursor-attempt.ts";
import { SessionOpenError, sessionStoreBusy } from "@ace/provider-kit/open-error";

/*
 * A Cursor turn a daemon crash cut short is reconciled with Cursor's own store at startup,
 * before it is called failed (ADR 0043, amendment of 2026-11-22). The restart pass leaves the
 * turn running and holds the queue with its continuation; this opens the thread's host, which
 * reads back what the daemon's record lacks:
 *
 * - a run Cursor finished ends completed with its stored result: the continuation is dropped and
 *   the queue goes on;
 * - a run that really was cut off ends failed, and the continuation stays held, as before;
 * - a send Cursor provably never received goes back in the queue and is sent once, and one it
 *   had is acknowledged (cursor-attempt.ts, run by every Cursor open).
 *
 * When the host can't be opened, the turn fails as a restart always failed it. Until then the
 * thread shows working: nothing in it is called done while Cursor may still own it.
 */

export interface ReconcileDependencies {
  repo: EngineRepository;
  recovery: Recovery;
  clock: EngineClock;
  actor(id: ThreadId): ThreadActor;
  open(actor: ThreadActor): Promise<void>;
  close(actor: ThreadActor): Promise<void>;
  wake(id: ThreadId): void;
  /**
   * The ADR 0211 handoff, as delivery and Resume use it: true when `error` said the saved
   * session can never open again and the thread now opens fresh with its context.
   */
  freshSession?(id: ThreadId, error: unknown): boolean;
  /** Waits between opens of a busy store; the turn shows working meanwhile. */
  retryMs?: readonly number[];
}
/** About 12 s in all, doubling from a tenth of a second. */
export const busyRetryMs: readonly number[] = [100, 200, 400, 800, 1600, 3200, 6000];

/** What a restart has always applied to cut-off Cursor work it could not reconcile. */
function restartFailure(repo: EngineRepository, id: ThreadId, at: number): Fact[] {
  const state = repo.requireState(id);
  const detail = lostWork(state, 0, "cursor-sdk", at);
  return [
    ...(detail
      ? [
          {
            type: "item.upsert" as const,
            agent: state.rootKey ?? "root",
            item: "recovery:uncertain",
            draft: {
              type: "notice" as const,
              level: "warning" as const,
              code: "recovery_uncertain",
              title: "Recovery needed",
              text: "Previous work needs reconciliation",
              detail,
              complete: true,
            },
          },
        ]
      : []),
    {
      type: "process.exited",
      deliberate: false,
      message: "Daemon restarted; previous provider work stopped",
    },
    { type: "queue.changed", source: "provider", count: 0 },
    interruptedNotice(state.rootKey, at, "restart"),
  ];
}

/** True when the root's last turn ended completed. */
function finished(repo: EngineRepository, id: ThreadId): boolean {
  const state = repo.requireState(id);
  const root = state.agents[state.rootKey ?? ""];
  const run = root?.lastRun ? state.runs[root.lastRun] : undefined;
  return run?.state === "completed";
}

/** The queue's restart hold and its continuation go: the turn they were for is complete. */
function release(deps: ReconcileDependencies, id: ThreadId): void {
  const { repo, recovery, clock } = deps;
  const queue = repo.queue.get(id);
  if (queue.trigger !== "restart" && queue.reason !== "restart") return;
  repo.pending.finishContinuation(id);
  const held = queue.reason === "restart" && !queue.limited;
  repo.queue.set(
    id,
    {
      continuation: null,
      trigger: null,
      ...(held ? { paused: false, reason: null } : {}),
      holdToken: queue.holdToken + 1,
    },
    clock.now(),
  );
  recovery.sync(id);
}

export async function reconcileCursorRestart(
  deps: ReconcileDependencies,
  id: ThreadId,
): Promise<void> {
  const { repo, clock } = deps;
  const before = repo.requireState(id);
  const wasRunning = before.agents[before.rootKey ?? ""]?.activeRun !== undefined;
  const fail = (actor?: ThreadActor) => {
    // A send whose fate can't be read stays held as uncertain, and the thread says so.
    repo.store.atomic(() => {
      const command = repo.recovery.attemptedCommand(id);
      const intent = command ? repo.pending.uncertainSend(id, command) : undefined;
      if (intent) unconfirmed(repo, id, intent.id, clock.now());
    });
    if (!wasRunning) return;
    const facts = restartFailure(repo, id, clock.now());
    if (actor) actor.apply(facts);
    else repo.store.atomic(() => repo.apply(id, facts, clock.now()));
  };
  if (!repo.reserve(id)) {
    fail();
    return;
  }
  const actor = deps.actor(id);
  // A store another writer holds is busy, not broken: the open is tried again, bounded.
  const waits = [...(deps.retryMs ?? busyRetryMs)];
  for (;;) {
    try {
      await deps.open(actor);
      await actor.flush();
      break;
    } catch (error) {
      const busy = error instanceof SessionOpenError && error.code === sessionStoreBusy;
      const wait = busy ? waits.shift() : undefined;
      if (wait === undefined) {
        // A saved session that can never open again hands off to a fresh one (ADR 0211), as
        // delivery and Resume do: the cut-off turn can't be read back, so it fails, and the
        // continuation and queued messages go to the fresh session with the thread's context.
        deps.freshSession?.(id, error);
        // The queue keeps its messages: only the turn fails.
        fail(actor);
        deps.wake(id);
        return;
      }
      await new Promise<void>((resolve) => clock.setTimer(resolve, wait));
    }
  }
  const state = repo.requireState(id);
  // No turn was running (a send Cursor may not have had): there is nothing to continue.
  if (!wasRunning) repo.store.atomic(() => release(deps, id));
  else if (state.agents[state.rootKey ?? ""]?.activeRun) {
    // Cursor's store said nothing that ends the turn: it is not left running on a guess.
    await deps.close(actor).catch(() => {});
    if (repo.requireState(id).agents[state.rootKey ?? ""]?.activeRun) fail(actor);
  } else if (finished(repo, id)) repo.store.atomic(() => release(deps, id));
  else actor.apply([interruptedNotice(state.rootKey, clock.now(), "restart")]);
  deps.wake(id);
}

/** The threads a startup marked for reconcile, run once the engine is ready. */
export class CursorReconciles {
  private marked = new Set<ThreadId>();
  private running = new Set<Promise<void>>();
  /** Threads marked or reconciling: no other work of theirs starts until it ends. */
  private held = new Set<ThreadId>();
  private report: (error: unknown) => void;
  private dependencies: () => ReconcileDependencies;
  constructor(report: (error: unknown) => void, dependencies: () => ReconcileDependencies) {
    this.report = report;
    this.dependencies = dependencies;
  }
  add(id: ThreadId): void {
    this.marked.add(id);
    this.held.add(id);
  }
  /**
   * True while `id` waits for or runs its reconcile, busy retries included. The thread's
   * delivery, control and steer lanes stay shut meanwhile, so a Resume can't open a second
   * session that fences the reconcile's; they wake once it ends.
   */
  holds(id: ThreadId): boolean {
    return this.held.has(id);
  }
  start(): void {
    const ids = [...this.marked];
    this.marked.clear();
    for (const id of ids) {
      // Never inside the caller's own frame: startup may still be building the engine.
      const running = Promise.resolve()
        .then(() => reconcileCursorRestart(this.dependencies(), id))
        .catch((error: unknown) => this.report(error))
        .finally(() => {
          this.running.delete(running);
          this.held.delete(id);
          this.dependencies().wake(id);
        });
      this.running.add(running);
    }
  }
  /** Resolves once every reconcile started so far has finished. */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all(this.running);
  }
}
