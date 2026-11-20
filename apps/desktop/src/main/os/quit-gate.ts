/**
 * Longest a quit waits for the app's own shutdown: the browser backend (2 s), then, on a complete
 * quit, the daemon this app started (SIGTERM, a 10 s grace, SIGKILL and 10 s more for its exit
 * report), with room to spare. Past it the app quits anyway, so a quit can never hang.
 */
export const quitBoundMs = 30_000;

export interface QuitGatePorts {
  /**
   * Stops what the app runs: the browser backend, then the daemon this app started on a complete
   * quit, or leaves that daemon running on a plain one (ADR 0186).
   */
  shutDown(): Promise<void>;
  /** Quits the app for real, once shutdown is over. */
  quit(): void;
  /**
   * Whether this quit may go on, asked before shutdown starts: false when the window couldn't
   * keep its unsaved editor text and asks the person instead. A failed check never holds a quit.
   */
  confirm?(): Promise<boolean>;
  /** The quit was called off by `confirm`. */
  cancelled?(): void;
  timers: { set(delayMs: number, callback: () => void): () => void };
  log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
  boundMs?: number;
}

/**
 * Holds every quit (Cmd+Q, the tray, closing the last window, an update's restart) until the
 * app has shut down: the browser backend always, and the daemon it started when the quit is
 * complete. Shutdown runs once: a second quit while it runs waits for the same one.
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
      void this.confirmed()
        .then(async (go) => {
          if (!go) {
            this.quitWhenDone = false;
            this.ports.log("info", "Quit called off: the window couldn't keep unsaved text");
            this.ports.cancelled?.();
            return;
          }
          await this.shutDown();
          this.ports.quit();
        })
        .catch((error: unknown) =>
          this.ports.log("error", "Quitting after shutdown failed", { error: String(error) }),
        );
    }
    return false;
  }

  /** Shutdown under way (an update's restart) is past asking. */
  private async confirmed(): Promise<boolean> {
    if (this.stopping || !this.ports.confirm) return true;
    try {
      return await this.ports.confirm();
    } catch (error) {
      this.ports.log("warn", "Checking before quit failed", { error: String(error) });
      return true;
    }
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
