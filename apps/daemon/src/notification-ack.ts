import type { DeviceId } from "@ace/protocol";

/** How long a live `notification` frame waits for the phone's `notification.ack` (ADR 0106). */
export const ackTimeoutMs = 3000;
/** Waiters held at once; delivery caps in-flight sends far below this. */
const maxWaiters = 256;

export interface AckTracker {
  /**
   * A phone took the live alert frame: waiting deliveries for it may skip the push. Only the
   * exact device and alert resolve; an ack from another phone never stands in for this one.
   */
  resolve(device: DeviceId, id: string): void;
  /**
   * Wait for the phone's ack, or false after the timeout. A replaced waiter resolves false,
   * so at most one waiter stands per device and alert.
   */
  wait(device: DeviceId, id: string): Promise<boolean>;
  /** Waiters still held; exposed for tests. */
  readonly pending: number;
}

/**
 * Delivery receipts for phones with a push address. Pure apart from the injected timer, so
 * tests drive the timeout without sleeping.
 */
const key = (device: DeviceId, id: string) => `${device}\n${id}`;
export function createAckTracker(
  delay: (run: () => void, milliseconds: number) => () => void = (run, milliseconds) => {
    const timer = setTimeout(run, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
): AckTracker {
  const waiters = new Map<string, (value: boolean) => void>();
  const finish = (id: string, value: boolean) => {
    waiters.get(id)?.(value);
  };
  return {
    resolve(device, id) {
      finish(key(device, id), true);
    },
    wait(device, id) {
      const own = key(device, id);
      // A second waiter for the same frame replaces the first, which resolves false.
      finish(own, false);
      if (waiters.size >= maxWaiters) {
        const oldest = waiters.keys().next().value;
        if (oldest !== undefined) finish(oldest, false);
      }
      return new Promise<boolean>((resolve) => {
        const done = (value: boolean) => {
          if (waiters.get(own) !== done) return;
          waiters.delete(own);
          cancel();
          resolve(value);
        };
        const cancel = delay(() => done(false), ackTimeoutMs);
        waiters.set(own, done);
      });
    },
    get pending() {
      return waiters.size;
    },
  };
}
