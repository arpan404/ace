import type { Actor } from "./session-options.ts";
import { BrowserActionError } from "./action-error.ts";

/**
 * Who may use one tab. Everyone may, except agents in a tab the person keeps private. `epoch`
 * moves whenever privacy changes, so an agent read that started before cannot finish after;
 * `generation` moves when the tab's page is lost, so queued work never runs on a new page.
 * Pure: clocks and persistence belong to the caller.
 */
export class TabAccess {
  private = false;
  epoch = 0;
  /** When privacy last changed; capture drops frames from before it. */
  since = -Infinity;
  generation = 0;
  /** Returns whether anything changed. */
  setPrivate(value: boolean, at: number): boolean {
    if (value === this.private) return false;
    this.private = value;
    this.epoch++;
    this.since = at;
    return true;
  }
  read(actor: Actor, epoch = this.epoch): void {
    if (actor.kind === "agent" && (this.private || epoch !== this.epoch))
      throw new BrowserActionError("human_private");
  }
  check(
    actor: Actor,
    state: { closed: boolean; paused: boolean },
    signal: AbortSignal | undefined,
    generation: number,
    epoch = this.epoch,
  ): void {
    signal?.throwIfAborted();
    if (state.closed) throw new BrowserActionError("browser_closed");
    this.read(actor, epoch);
    if (state.paused) throw new BrowserActionError("browser_paused");
    if (generation !== this.generation) throw new BrowserActionError("backend_changed");
  }
}
