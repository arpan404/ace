/** Web Locks queue standby windows without any broker polling. Closing a window releases ownership. */
export function brokerLeader(
  locks: Pick<LockManager, "request"> | undefined,
  key: string,
  start: () => () => void,
) {
  const controller = new AbortController();
  // Without a coordination primitive, do not start competing brokers.
  if (!locks) return () => controller.abort();
  let release: (() => void) | undefined;
  void locks
    .request(`ace-remote-broker:${key}`, { signal: controller.signal }, async () => {
      if (controller.signal.aborted) return;
      const stop = start();
      try {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      } finally {
        stop();
      }
    })
    .catch(() => {});
  return () => {
    controller.abort();
    release?.();
  };
}
