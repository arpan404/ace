interface StoreShutdown {
  flush(): void;
  stop: readonly (() => void)[];
  workers(): Promise<void>;
  release(): void;
}

/** Keep synchronous connection disposal, but join workers and report every cleanup failure. */
export async function closeStore(resources: StoreShutdown): Promise<void> {
  const errors: unknown[] = [];
  const attempt = (close: () => void) => {
    try {
      close();
    } catch (error) {
      errors.push(error);
    }
  };
  attempt(resources.flush);
  for (const stop of resources.stop) attempt(stop);
  let workers = Promise.resolve();
  attempt(() => {
    workers = resources.workers();
  });
  attempt(resources.release);
  try {
    await workers;
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Store shutdown failed");
}
