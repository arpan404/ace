/** Web Locks queue standby windows without any broker polling. Closing a window releases ownership. */
export function brokerLeader(
  locks: Pick<LockManager, "request"> | undefined,
  key: string,
  start: (yieldLeadership: () => void) => () => void,
) {
  const controller = new AbortController();
  // Without a coordination primitive, do not start competing brokers.
  if (!locks) return () => controller.abort();
  let release: (() => void) | undefined;
  void locks
    .request(`ace-remote-broker:${key}`, { signal: controller.signal }, async () => {
      if (controller.signal.aborted) return;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stop = start(() => release?.());
      try {
        await held;
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
