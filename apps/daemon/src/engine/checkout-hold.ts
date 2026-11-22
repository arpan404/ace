import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ThreadId } from "@ace/protocol";
import type { EngineClock } from "./actor.ts";
import type { EngineRepository } from "./repository.ts";

/**
 * How long one held source control change may take end to end (waiting for the Git lock, moving
 * files to Recently deleted, Git itself). Past it the change is cancelled; the hold lifts only
 * once the work has actually stopped.
 */
export const checkoutHoldDeadlineMs = 10 * 60_000;

/** How often a hold restored after a restart looks for Git's index lock again. */
export const checkoutHoldPollMs = 2_000;

/** Where Git keeps the worktree's index lock: `.git/index.lock`, or in a linked worktree's gitdir. */
function indexLock(top: string): string {
  const dotGit = join(top, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, "index.lock");
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (pointer) return join(resolve(top, pointer), "index.lock");
  } catch {
    // No `.git` at all: nothing can hold its index.
  }
  return join(dotGit, "index.lock");
}

/** A path as the filesystem resolves it, or as written when it is gone. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** One path is the other or lies inside it: an agent at either can write into both. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/** One source control change asking to hold the Git worktree at `top`. */
export interface CheckoutHoldRequest<T> {
  /** The thread the change was asked from: it says Git is busy too. */
  threadId: ThreadId;
  commandId: string;
  top: string;
  effect: (signal: AbortSignal) => Promise<T>;
}

/**
 * Git worktrees held for one source control change (discard, switch, pull, stash), keyed by the
 * worktree's canonical top level. A held worktree takes new work as usual (a send, queued work,
 * a thread created there) but nothing dispatches and no session opens for a thread whose checkout
 * lies in it, contains it, or can't be told, until the change ends. Nothing is refused or lost.
 */
export class CheckoutHolds {
  readonly #held = new Map<string, string>();
  readonly #repo: EngineRepository;
  readonly #clock: EngineClock;
  /** A hold lifted: what waited in its worktree may run now. */
  readonly #released: () => void;
  constructor(repo: EngineRepository, clock: EngineClock, released: () => void) {
    this.#repo = repo;
    this.#clock = clock;
    this.#released = released;
  }
  /** Whether `id` must wait: its checkout overlaps a held worktree (or its checkout is unknown). */
  covers(id: ThreadId): boolean {
    if (this.#held.size === 0) return false;
    let cwd: string;
    try {
      cwd = canonical(this.#repo.session(id).cwd);
    } catch {
      return true;
    }
    for (const top of this.#held.keys()) if (overlaps(cwd, top)) return true;
    return false;
  }
  /** Whether any of `roots` overlaps a held worktree. */
  touches(roots: readonly string[]): boolean {
    for (const root of roots) {
      const path = canonical(root);
      for (const top of this.#held.keys()) if (overlaps(path, top)) return true;
    }
    return false;
  }
  /**
   * Hold the worktree at `top` while `effect` runs. Refused (`agent_working`) when a thread in
   * it is running, opening a session or has work in flight; refused when a workspace change or
   * another hold already has it. The check and the hold happen in one synchronous step.
   */
  async hold<T>(
    input: CheckoutHoldRequest<T> & {
      live: Iterable<ThreadId>;
      opening: (id: ThreadId) => boolean;
    },
  ): Promise<T> {
    const top = canonical(input.top);
    const reservations = this.#repo.store.workspaceReservations;
    if (this.touches([top]) || reservations.holds(top))
      throw new Error("workspace_change_in_progress");
    const marked = new Set<ThreadId>([input.threadId]);
    for (const id of input.live) {
      if (!this.#coversPath(id, top)) continue;
      marked.add(id);
      const state = this.#repo.state(id);
      if (
        (state && !this.#repo.quiescent(state)) ||
        this.#repo.pending.running(id) ||
        input.opening(id)
      )
        throw new Error("agent_working");
    }
    this.#held.set(top, input.commandId);
    const threads = [...marked];
    reservations.recordCheckoutHold(top, input.commandId, this.#clock.now(), threads);
    this.#mark(threads, { since: this.#clock.now() });
    const deadline = new AbortController();
    const cancelTimer = this.#clock.setTimer(() => deadline.abort(), checkoutHoldDeadlineMs);
    try {
      // Released only once the effect settles: cancelled Git is waited for, never abandoned.
      return await input.effect(deadline.signal);
    } finally {
      cancelTimer();
      this.#held.delete(top);
      reservations.dropCheckoutHold(top);
      this.#mark(threads, undefined);
      this.#released();
    }
  }
  /**
   * Holds a daemon left when it stopped mid-change. Each worktree stays held (before any queued
   * work is recovered) while Git's index lock is there, since a Git it started may still be
   * writing; it lifts once the lock is gone. Past the deadline it lifts regardless: the lock is
   * then Git's stale lock, recovered by the Git lock handling, and never holds threads forever.
   */
  restore(): void {
    const reservations = this.#repo.store.workspaceReservations;
    for (const record of reservations.checkoutHolds()) {
      this.#held.set(record.top, record.commandId);
      const look = () => {
        if (this.#held.get(record.top) !== record.commandId) return;
        const expired = this.#clock.now() - record.at >= checkoutHoldDeadlineMs;
        if (existsSync(indexLock(record.top)) && !expired) {
          this.#clock.setTimer(look, checkoutHoldPollMs);
          return;
        }
        this.#held.delete(record.top);
        reservations.dropCheckoutHold(record.top);
        this.#mark(record.threads, undefined);
        this.#released();
      };
      this.#clock.setTimer(look, checkoutHoldPollMs);
    }
  }
  /** Say (or stop saying) on each thread that Git is busy in its worktree. */
  #mark(ids: readonly ThreadId[], busy: { since: number } | undefined): void {
    const store = this.#repo.store;
    for (const id of ids) {
      const thread = store.getThread(id);
      if (!thread || thread.deletedAt !== undefined) continue;
      const { gitBusy: _was, ...details } = thread.details ?? {};
      if (!busy && !_was) continue;
      store.appendEvents(
        id,
        [
          {
            type: "thread.client.updated",
            changes: { details: busy ? { ...details, gitBusy: busy } : details },
          },
        ],
        this.#clock.now(),
      );
    }
  }
  #coversPath(id: ThreadId, top: string): boolean {
    try {
      return overlaps(canonical(this.#repo.session(id).cwd), top);
    } catch {
      return true;
    }
  }
}
