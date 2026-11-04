import type { Store } from "../store.ts";

/** How often the busy count is read again regardless, in case a change went unheard. */
export const busyPollMs = 30_000;

/**
 * Calls `listener` when the count of threads at work or waiting may have changed: after any
 * burst of thread status changes (once per burst), and every `busyPollMs` as a backstop. Deltas
 * and other events never recount.
 */
export function watchBusy(
  store: Pick<Store, "subscribe">,
  clock: { delay(callback: () => void, ms: number): () => void },
  listener: () => void,
): () => void {
  let queued = false;
  const stopStore = store.subscribe((events) => {
    if (queued) return;
    if (!events.some((event) => event.payload.type === "thread.updated" && event.payload.status))
      return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      listener();
    });
  });
  let cancel = () => {};
  const poll = () => {
    cancel = clock.delay(() => {
      listener();
      poll();
    }, busyPollMs);
  };
  poll();
  return () => {
    stopStore();
    cancel();
  };
}
