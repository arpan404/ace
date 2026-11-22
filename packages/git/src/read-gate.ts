import { GitError } from "./types.ts";

/*
 * At most `limit` history reads (a file's log, a commit's diff) run at once across the service;
 * the rest wait their turn. A waiter whose signal aborts leaves the queue. These reads only look
 * at immutable commits, so they don't take the repository's serial lock and never hold up its
 * writes or status reads.
 */
export class ReadGate {
  readonly #limit: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#enter(signal);
    try {
      return await work();
    } finally {
      this.#running--;
      this.#waiting.shift()?.();
    }
  }

  #enter(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.#running < this.#limit) {
      this.#running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener("abort", leave);
        this.#running++;
        resolve();
      };
      const leave = () => {
        const at = this.#waiting.indexOf(turn);
        if (at >= 0) this.#waiting.splice(at, 1);
        reject(cancelled());
      };
      signal?.addEventListener("abort", leave, { once: true });
      this.#waiting.push(turn);
    });
  }
}

function cancelled(): GitError {
  return new GitError("git_cancelled", "Git operation cancelled before dispatch");
}
