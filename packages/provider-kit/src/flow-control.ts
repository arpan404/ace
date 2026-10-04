/** A transport reads only while its owner has room to accept another fact. */
export interface OutputFlow {
  paused(): boolean;
  wait(): Promise<void>;
}

/** Cancellation releases the transport even if its owner's capacity never returns. */
export async function waitForOutput(
  flow: OutputFlow | undefined,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!flow?.paused()) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void Promise.resolve()
      .then(() => flow.wait())
      .then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
  signal.throwIfAborted();
}
