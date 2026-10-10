/** Web Locks queue standby windows without any broker polling. Closing a window releases ownership. */
export function brokerLeader(
  locks: Pick<LockManager, "request">,
  key: string,
  start: () => () => void,
) {
  const controller = new AbortController();
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
