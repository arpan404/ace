/**
 * One socket's workspace reads: at most `limit` run at once and later ones wait their turn.
 *
 * A panel opens with a burst of reads (a PR's detail, files, merge state, stack and review
 * state at once, beside the thread's own Git reads). Refusing the excess made ordinary reads
 * fail whenever one slow read held a slot, so they queue instead. Only the backlog is bounded.
 */
export class WorkspaceReadQueue {
  private readonly limit: number;
  private readonly backlog: number;
  private running = 0;
  private waiting: (() => void)[] = [];
  private closed = false;
  constructor(limit: number, backlog: number) {
    this.limit = limit;
    this.backlog = backlog;
  }
  /**
   * Starts `read` now or once a slot frees, holding the slot until it settles. False when the
   * backlog is full or the queue is closed: the read never starts and the caller refuses it.
   */
  admit(read: () => Promise<unknown>): boolean {
    if (this.closed) return false;
    if (this.running < this.limit) {
      this.running++;
      this.start(read);
      return true;
    }
    if (this.waiting.length >= this.backlog) return false;
    this.waiting.push(() => this.start(read));
    return true;
  }
  /** Drops every waiting read; running ones finish on their own. */
  close(): void {
    this.closed = true;
    this.waiting = [];
  }
  private start(read: () => Promise<unknown>): void {
    let task: Promise<unknown>;
    try {
      task = read();
    } catch {
      task = Promise.resolve();
    }
    void task.then(
      () => this.release(),
      () => this.release(),
    );
  }
  private release(): void {
    // The slot passes straight to the next waiter, so a new read cannot overtake it.
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}
