import type { BrowserControllerLease } from "@ace/protocol";
import type { Actor } from "./session-options.ts";
import { BrowserActionError } from "./action-error.ts";

/** Pure ownership decisions. Persistence, transport changes and clocks belong to the session. */
export class SessionOwnership {
  controller: "agent" | "human" | "none" = "agent";
  owner: string | undefined;
  mode: "shared" | "private" = "shared";
  epoch = 0;
  since = -Infinity;
  generation = 0;
  lease(): BrowserControllerLease {
    return {
      generation: ++this.generation,
      controller: this.controller,
      ...(this.owner ? { owner: this.owner } : {}),
    };
  }
  prepareTakeover(connectionId: string, mode: "shared" | "private"): boolean {
    if (this.owner && this.owner !== connectionId)
      throw new Error("Browser already controlled by another connection");
    if (this.mode === "private" && mode !== "private")
      throw new Error("Private browser requires explicit handback");
    return this.owner !== connectionId || this.mode !== mode;
  }
  takeover(connectionId: string, mode: "shared" | "private", at: number): void {
    if (this.mode === "private" || mode === "private") {
      this.epoch++;
      this.since = at;
    }
    this.mode = mode;
    this.controller = "human";
    this.owner = connectionId;
  }
  handback(connectionId: string, at: number): void {
    if (this.owner !== connectionId) throw new Error("Browser controller mismatch");
    if (this.mode === "private") {
      this.epoch++;
      this.since = at;
    }
    this.mode = "shared";
    this.controller = "agent";
    this.owner = undefined;
  }
  restorePrivate(at: number): void {
    this.mode = "private";
    this.controller = "human";
    this.epoch++;
    this.since = at;
  }
  read(actor: Actor, epoch = this.epoch): void {
    if (actor.kind === "agent" && (this.mode === "private" || epoch !== this.epoch))
      throw new BrowserActionError("human_private");
  }
  check(
    actor: Actor,
    state: { closed: boolean; paused: boolean },
    signal: AbortSignal | undefined,
    generation: number,
  ): void {
    signal?.throwIfAborted();
    if (state.closed) throw new BrowserActionError("browser_closed");
    this.read(actor);
    if (state.paused) throw new BrowserActionError("browser_paused");
    if (actor.kind === "agent" && this.controller !== "agent")
      throw new BrowserActionError("human_controlled");
    if (generation !== this.generation)
      throw new BrowserActionError(
        "controller_changed",
        "Browser control changed while the action was queued",
        "Take a fresh snapshot and retry after control is handed back.",
      );
    if (
      actor.kind === "human" &&
      (this.controller !== "human" || this.owner !== actor.connectionId)
    )
      throw new Error("Browser controller mismatch");
  }
}
