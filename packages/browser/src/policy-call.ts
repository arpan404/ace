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
  run<T>(signal: AbortSignal, work: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error("Browser service shutting down"));
    if (this.active >= 32) return Promise.reject(new Error("Browser policy admission limit"));
    this.active++;
    const task = Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new Error("Browser service shutting down");
        return work();
      })
      .finally(() => {
        this.active--;
      });
    return callPolicy(signal, () => task, timeoutMs);
  }
}
