/** Approval hooks may wait on external I/O. Shutdown must not wait on them. */
export function callPolicy<T>(signal: AbortSignal, work: () => T | Promise<T>): Promise<T> {
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
    timer = setTimeout(() => fail(new Error("Browser policy timed out")), 10_000);
    Promise.resolve().then(work).then(pass, fail);
  });
}
