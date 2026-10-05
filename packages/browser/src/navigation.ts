import { PublicToolError } from "@ace/mcp-server";
import type { BrowserOriginBlock } from "@ace/protocol";

/** Monotonic time and cancellable timers supplied by the service's I/O boundary. */
export interface NavigationClock {
  now(): number;
  set(delay: number, work: () => void): () => void;
}
/** One explicit navigation owns provenance, policy cancellation and load budget.
 * Policy waits pause the load budget; the total approval reserve is bounded. */
export class NavigationTask {
  readonly human: boolean;
  readonly signal: AbortSignal;
  blocked: BrowserOriginBlock | undefined;
  policyOrigin: string | undefined;
  deadlineExpired = false;
  expiredOrigin: string | undefined;
  private controller = new AbortController();
  private clock: NavigationClock;
  private remaining: number;
  private started: number;
  private paused = 0;
  private cancelLoad: () => void = () => {};
  private cancelWall: () => void;
  private unbind: () => void;
  constructor(human: boolean, timeout: number, clock: NavigationClock, parent?: AbortSignal) {
    this.human = human;
    this.clock = clock;
    this.remaining = timeout;
    this.started = clock.now();
    this.signal = this.controller.signal;
    const abort = () => this.controller.abort(parent?.reason ?? new Error("Navigation cancelled"));
    parent?.addEventListener("abort", abort, { once: true });
    this.unbind = () => parent?.removeEventListener("abort", abort);
    this.cancelWall = clock.set(timeout + 65_000, () =>
      this.expire("Browser navigation approval deadline exceeded"),
    );
    this.resumeLoad();
    if (parent?.aborted) abort();
  }
  private resumeLoad(): void {
    this.started = this.clock.now();
    this.cancelLoad = this.clock.set(Math.max(0, this.remaining), () =>
      this.expire("Browser navigation timed out"),
    );
  }
  private expire(message: string): void {
    this.deadlineExpired = true;
    this.expiredOrigin = this.policyOrigin;
    this.controller.abort(new PublicToolError("timeout"));
    void message;
  }
  pause(): () => void {
    if (this.paused++ === 0) {
      this.cancelLoad();
      this.remaining -= this.clock.now() - this.started;
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (--this.paused === 0 && !this.signal.aborted) this.resumeLoad();
    };
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          this.signal.throwIfAborted();
          return work();
        })
        .then(resolve, reject)
        .finally(() => this.signal.removeEventListener("abort", abort));
      if (this.signal.aborted) abort();
    });
  }
  close(): void {
    this.cancelLoad();
    this.cancelWall();
    this.unbind();
    this.controller.abort(new Error("Navigation finished"));
  }
}
