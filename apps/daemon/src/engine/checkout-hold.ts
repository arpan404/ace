import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

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

/**
 * Git worktrees held for one source control change (discard, switch, pull, stash), keyed by the
 * worktree's canonical top level. A held worktree takes new work as usual (a send, queued work,
 * a thread created there) but nothing dispatches and no session opens for a thread whose checkout
 * lies in it, contains it, or can't be told, until the change ends. Nothing is refused or lost.
 */
export class CheckoutHolds {
  readonly #held = new Map<string, string>();
  readonly #repo: EngineRepository;
  constructor(repo: EngineRepository) {
    this.#repo = repo;
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
  async hold<T>(input: {
    commandId: string;
    top: string;
    live: Iterable<ThreadId>;
    opening: (id: ThreadId) => boolean;
    released: (top: string) => void;
    effect: () => Promise<T>;
  }): Promise<T> {
    const top = canonical(input.top);
    const reservations = this.#repo.store.workspaceReservations;
    if (this.touches([top]) || reservations.holds(top))
      throw new Error("workspace_change_in_progress");
    for (const id of input.live) {
      if (!this.#coversPath(id, top)) continue;
      const state = this.#repo.state(id);
      if (
        (state && !this.#repo.quiescent(state)) ||
        this.#repo.pending.running(id) ||
        input.opening(id)
      )
        throw new Error("agent_working");
    }
    this.#held.set(top, input.commandId);
    try {
      return await input.effect();
    } finally {
      this.#held.delete(top);
      input.released(top);
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
