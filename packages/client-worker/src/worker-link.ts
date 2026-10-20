import type { DiagnosticEvent, Scheduler } from "@ace/client";
import { WorkerLiveness } from "./worker-liveness.ts";
import type { PortLike, TabMessage } from "./wire.ts";

/** The owning Worker/SharedWorker handle reports load/runtime errors here. */
export interface WorkerFailure {
  watch(lost: () => void): () => void;
  close?(): void;
}
/** A worker to talk to: its port, and how it reports failing. */
export interface WorkerHandle {
  port: PortLike;
  failure?: WorkerFailure | undefined;
  /** For the diagnostics log only. */
  kind?: "shared" | "dedicated";
}
/** Why a worker was given up on: it stopped answering, or it reported an error. */
export type WorkerLoss = "timeout" | "error";

export interface WorkerLinkOptions {
  scheduler: Scheduler;
  pingMs: number;
  timeoutMs: number;
  /**
   * A fresh worker after one was lost. `attempt` counts the fresh workers already tried since
   * the last one that stayed healthy (0 for the first). Absent: a lost worker stays lost.
   */
  respawn?(loss: { cause: WorkerLoss; attempt: number }): WorkerHandle | undefined;
  report?(event: DiagnosticEvent): void;
  now?(): number;
  receive(data: unknown): void;
  /** The current worker is gone; until `replaced`, posts go nowhere. */
  lost(cause: WorkerLoss): void;
  /** A fresh worker is in place: tell it everything the tab holds. */
  replaced(): void;
}

const respawnBaseMs = 500;
const respawnCapMs = 30_000;
/** A worker attached this long has proven itself; the next loss starts the backoff over. */
const healthyMs = 30_000;

/** Wait before the next fresh worker: none for the first, then doubling up to a cap. */
export function respawnDelay(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(respawnCapMs, respawnBaseMs * 2 ** Math.min(attempt - 1, 16));
}

/**
 * The tab's line to its client worker (ADR 0056): one port at a time, watched by pings and the
 * worker's error events. A lost worker is replaced by a fresh one with bounded backoff, for as
 * long as the tab lives, when a `respawn` is given.
 */
export class WorkerLink {
  #options: WorkerLinkOptions;
  #handle: WorkerHandle | undefined;
  #monitor: WorkerLiveness | undefined;
  #stopFailure: (() => void) | undefined;
  #listener: ((event: { data: unknown }) => void) | undefined;
  #visible = true;
  #started = false;
  #closed = false;
  #attempt = 0;
  #cause: WorkerLoss = "timeout";
  #lostAt: number | undefined;
  #recovering = false;
  #retry: (() => void) | undefined;
  #healthy: (() => void) | undefined;
  /** Bumped for every worker installed, so a message can tell which worker it reached. */
  generation = 0;
  constructor(handle: WorkerHandle, options: WorkerLinkOptions) {
    this.#options = options;
    this.#install(handle);
  }
  /** Whether a lost worker is replaced, rather than ending the client. */
  get recovers(): boolean {
    return this.#options.respawn !== undefined;
  }
  /** Whether a worker is in place to post to. */
  get connected(): boolean {
    return this.#handle !== undefined;
  }
  start(): void {
    this.#started = true;
    this.#monitor?.start();
  }
  /** The worker's client has loaded this tab's outbox. */
  attached(): void {
    this.#monitor?.attached();
    if (!this.#recovering) return;
    this.#recovering = false;
    const now = this.#options.now?.();
    this.#report("client-worker.recovered", {
      attempts: this.#attempt,
      kind: this.#handle?.kind ?? null,
      ...(now !== undefined && this.#lostAt !== undefined ? { afterMs: now - this.#lostAt } : {}),
    });
    this.#healthy?.();
    this.#healthy = this.#options.scheduler.set(healthyMs, () => {
      this.#healthy = undefined;
      this.#attempt = 0;
    });
  }
  received(): void {
    this.#monitor?.received();
  }
  visible(value: boolean): void {
    this.#visible = value;
    this.#monitor?.visible(value);
  }
  /** Post to the current worker; false when there is none, or the post failed. */
  post(message: TabMessage): boolean {
    const port = this.#handle?.port;
    if (!port || this.#closed) return false;
    try {
      // A MessagePort has no target origin: it reaches exactly the other end.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      port.postMessage(message);
      return true;
    } catch {
      this.lose("error");
      return false;
    }
  }
  /** Give up on the current worker and, when the link recovers, schedule a fresh one. */
  lose(cause: WorkerLoss): void {
    if (this.#closed || !this.#handle) return;
    this.#teardown();
    this.#healthy?.();
    this.#healthy = undefined;
    this.#cause = cause;
    if (!this.#recovering) this.#lostAt = this.#options.now?.();
    this.#recovering = true;
    this.#options.lost(cause);
    if (!this.recovers) return;
    const delay = respawnDelay(this.#attempt);
    this.#report("client-worker.lost", { cause, attempt: this.#attempt, retryInMs: delay });
    this.#schedule(delay);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#retry?.();
    this.#healthy?.();
    this.#teardown();
  }
  #schedule(delay: number): void {
    this.#retry?.();
    this.#retry = this.#options.scheduler.set(delay, () => {
      this.#retry = undefined;
      this.#respawn();
    });
  }
  #respawn(): void {
    if (this.#closed || this.#handle) return;
    const attempt = this.#attempt++;
    let handle: WorkerHandle | undefined;
    try {
      handle = this.#options.respawn?.({ cause: this.#cause, attempt });
    } catch {
      handle = undefined;
    }
    if (!handle) {
      const delay = respawnDelay(this.#attempt);
      this.#report("client-worker.respawn-failed", { attempt, retryInMs: delay });
      this.#schedule(delay);
      return;
    }
    this.#install(handle);
    this.#report("client-worker.respawned", { attempt, kind: handle.kind ?? null });
    if (this.#started) {
      this.#monitor?.start();
      this.#options.replaced();
    }
  }
  #install(handle: WorkerHandle): void {
    this.generation++;
    this.#handle = handle;
    const generation = this.generation;
    const listener = (event: { data: unknown }) => {
      if (generation === this.generation && this.#handle) this.#options.receive(event.data);
    };
    this.#listener = listener;
    this.#monitor = new WorkerLiveness(
      this.#options.scheduler,
      () => this.post({ t: "ping" }),
      () => {
        if (generation === this.generation) this.lose("timeout");
      },
      this.#options.pingMs,
      this.#options.timeoutMs,
    );
    if (!this.#visible) this.#monitor.visible(false);
    this.#stopFailure = handle.failure?.watch(() => {
      if (generation === this.generation) this.lose("error");
    });
    handle.port.addEventListener("message", listener);
    handle.port.start?.();
  }
  #teardown(): void {
    const handle = this.#handle;
    this.#handle = undefined;
    try {
      // A worker that is only slow lets go of this tab's leases at once, rather than on silence.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      handle?.port.postMessage({ t: "bye" } satisfies TabMessage);
    } catch {
      /* Gone already. */
    }
    this.#monitor?.close();
    this.#monitor = undefined;
    this.#stopFailure?.();
    this.#stopFailure = undefined;
    if (!handle) return;
    if (this.#listener) handle.port.removeEventListener("message", this.#listener);
    this.#listener = undefined;
    try {
      handle.port.close?.();
      handle.failure?.close?.();
    } catch {
      /* A worker that is already gone has nothing left to close. */
    }
  }
  #report(event: string, data: Record<string, string | number | boolean | null>): void {
    try {
      this.#options.report?.({ event, data });
    } catch {
      /* A broken log never breaks the link. */
    }
  }
}
