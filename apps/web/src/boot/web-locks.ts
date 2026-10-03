import type { Liveness } from "@ace/client-worker";

/*
 * Tab liveness through Web Locks (ADR 0056). A tab holds a lock named for itself while it lives;
 * the client worker asks for the same lock, which the browser grants only once the tab has
 * closed or crashed. A hidden tab whose timers are throttled or frozen keeps its lock, so the
 * worker never mistakes it for a dead one. Undefined where the browser has no Web Locks.
 */

const locks = (): LockManager | undefined =>
  typeof navigator === "object" && "locks" in navigator ? navigator.locks : undefined;

/** The tab's side: hold a lock of its own until `release`. */
export function tabLiveness(): Liveness | undefined {
  const manager = locks();
  if (!manager) return undefined;
  return {
    hold() {
      const name = `ace-tab-${crypto.randomUUID()}`;
      return new Promise((resolve, reject) => {
        manager
          .request(
            name,
            () =>
              new Promise<void>((release) => {
                resolve({ name, release: () => release() });
              }),
          )
          .catch(reject);
      });
    },
  };
}

/** The worker's side: call `gone` once the named tab's lock is free. */
export function lockReleased(name: string, gone: () => void): () => void {
  const manager = locks();
  if (!manager) return () => {};
  const controller = new AbortController();
  manager
    .request(name, { signal: controller.signal }, () => gone())
    .catch(() => {
      /* Aborted: the worker stopped watching this tab. */
    });
  return () => controller.abort();
}
