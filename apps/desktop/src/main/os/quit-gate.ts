/**
 * Longest a quit waits for the app's own shutdown: the browser backend (2 s), then the daemon
 * this app started (SIGTERM, a 10 s grace, SIGKILL and 10 s more for its exit report), with
 * room to spare. Past it the app quits anyway, so a quit can never hang.
 */
export const quitBoundMs = 30_000;

export interface QuitGatePorts {
  /** Stops what the app runs: the browser backend, then the daemon this app started. */
  shutDown(): Promise<void>;
  /** Quits the app for real, once shutdown is over. */
  quit(): void;
  timers: { set(delayMs: number, callback: () => void): () => void };
  log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
  boundMs?: number;
}

/**
 * Holds every quit (Cmd+Q, the tray, closing the last window, an update's restart) until the
 * app has shut down, the daemon it started included, so that daemon never outlives the app
 * holding ace's data. Shutdown runs once: a second quit while it runs waits for the same one.
 */
export class QuitGate {
  private ports: QuitGatePorts;
  private stopping: Promise<void> | undefined;
  private done = false;
  private quitWhenDone = false;

  constructor(ports: QuitGatePorts) {
    this.ports = ports;
  }

  /** Shutdown is over (or ran past its bound): the app may quit now. */
  get finished(): boolean {
    return this.done;
  }

  /** Shutdown has begun; a quit now needs no more questions. */
  get started(): boolean {
    return this.stopping !== undefined;
  }

  /**
   * Shut down once; later calls share the same run. Resolves when it is over, or after the
   * bound if part of it hangs.
   */
  shutDown(): Promise<void> {
    this.stopping ??= this.bounded().then(() => {
      this.done = true;
    });
    return this.stopping;
  }

  /**
   * A quit request (Electron's `before-quit`). True when the quit may go ahead now. Otherwise
   * the caller holds the quit back: shutdown starts, if it has not, and the app quits after.
   */
  request(): boolean {
    if (this.done) return true;
    if (!this.quitWhenDone) {
      this.quitWhenDone = true;
      void this.shutDown().then(() => this.ports.quit());
    }
    return false;
  }

  private async bounded(): Promise<void> {
    const boundMs = this.ports.boundMs ?? quitBoundMs;
    const overrun = Promise.withResolvers<"overrun">();
    const cancel = this.ports.timers.set(boundMs, () => overrun.resolve("overrun"));
    const work = this.ports.shutDown().then(
      () => "done" as const,
      (error: unknown) => {
        this.ports.log("error", "Shutting down before quit failed", { error: String(error) });
        return "done" as const;
      },
    );
    const outcome = await Promise.race([work, overrun.promise]);
    cancel();
    if (outcome === "overrun")
      this.ports.log("error", "Shutting down took too long; quitting anyway", { boundMs });
  }
}
