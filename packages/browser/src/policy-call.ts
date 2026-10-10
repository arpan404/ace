/** Approval hooks may wait on external I/O. Shutdown must not wait on them. */
export function callPolicy<T>(
  signal: AbortSignal,
  work: () => T | Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Browser service shutting down"));
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const pass = (value: T) => {
      cleanup();
      resolve(value);
    };
    const abort = () => fail(new Error("Browser service shutting down"));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => fail(new Error("Browser policy timed out")), timeoutMs);
    Promise.resolve().then(work).then(pass, fail);
  });
}

/** Admission covers all approval transports. Uncooperative hooks keep their
 * slot until they settle, even after their caller's deadline or cancellation. */
export class PolicyGate {
  private active = 0;
  private waiting: (() => void)[] = [];
  run<T>(signal: AbortSignal, work: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error("Browser service shutting down"));
    if (this.waiting.length >= 1024) return Promise.reject(new Error("Browser policy queue full"));
    const task = new Promise<T>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          reject(signal.reason);
          this.next();
          return;
        }
        this.active++;
        const running = Promise.resolve().then(work);
        void running
          .finally(() => {
            this.active--;
            this.next();
          })
          .catch(() => {});
        callPolicy(signal, () => running, timeoutMs).then(resolve, reject);
      };
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      if (this.active < 32) start();
      else {
        this.waiting.push(start);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    return task;
  }
  private next(): void {
    if (this.active < 32) this.waiting.shift()?.();
  }
}
