/*
 * One load per key shared by everyone waiting for it. Each waiter leaves on its own signal
 * without disturbing the others; the load's own signal aborts only once every waiter has left,
 * so a process (git) runs while anyone still wants its answer and stops when no one does.
 */

interface Run<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

export class SharedWork<T> {
  readonly #runs = new Map<string, Run<T>>();

  /** Waits for `key`'s running load, starting one when none runs. */
  join(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#wait(key, this.#runs.get(key) ?? this.#begin(key, load), signal);
  }

  /** Starts a new load for `key` (a fresh read), which later waiters then share. */
  start(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#wait(key, this.#begin(key, load), signal);
  }

  #begin(key: string, load: (signal: AbortSignal) => Promise<T>): Run<T> {
    const controller = new AbortController();
    const run: Run<T> = { promise: load(controller.signal), controller, waiters: 0 };
    this.#runs.set(key, run);
    const forget = () => {
      if (this.#runs.get(key) === run) this.#runs.delete(key);
    };
    run.promise.then(forget, forget);
    return run;
  }

  #wait(key: string, run: Run<T>, signal: AbortSignal | undefined): Promise<T> {
    run.waiters++;
    return new Promise<T>((resolve, reject) => {
      let gone = false;
      const leave = () => {
        if (gone) return;
        gone = true;
        run.waiters--;
        if (run.waiters === 0) {
          run.controller.abort();
          if (this.#runs.get(key) === run) this.#runs.delete(key);
        }
        reject(signal?.reason ?? new Error("cancelled"));
      };
      if (signal?.aborted) return leave();
      signal?.addEventListener("abort", leave, { once: true });
      run.promise.then(
        (value) => {
          if (gone) return;
          gone = true;
          signal?.removeEventListener("abort", leave);
          run.waiters--;
          resolve(value);
        },
        (error: unknown) => {
          if (gone) return;
          gone = true;
          signal?.removeEventListener("abort", leave);
          run.waiters--;
          reject(error);
        },
      );
    });
  }
}
