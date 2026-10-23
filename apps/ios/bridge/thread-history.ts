import type { ClientCore, ThreadSource } from "@ace/client";

/*
 * A window larger than the daemon's 200-item snapshot (the fixture's 2,200) fills in behind the
 * first paint: the thread shows its latest items at once, and older pages are read one at a time,
 * each only once native has everything before it, so live changes never queue behind history.
 */
export async function fillHistory(options: {
  owner: ClientCore;
  store: ThreadSource;
  threadId: string;
  limit: number;
  /** False once the person left this visit. */
  current: () => boolean;
  /** Resolves when the bridge has nothing left to deliver. */
  drained: () => Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const { owner, store, threadId, limit, current, drained, signal } = options;
  await new Promise<void>((resolve) => {
    if (store.thread || store.error || signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      stop();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const stop = store.observe(() => {
      if (store.thread || store.error) done();
    });
    signal.addEventListener("abort", done, { once: true });
  });
  while (store.itemsBefore != null && store.order.length < limit) {
    await drained();
    if (!current() || signal.aborted) return;
    const before = store.order.length;
    await owner.loadOlder(threadId, Math.min(200, limit - before), { signal });
    // The SDK's own window is full (or the page came back empty): nothing more fits.
    if (store.order.length <= before) return;
  }
}
