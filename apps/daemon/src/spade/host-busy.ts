/**
 * Whether Spade's host thread tree is busy, read again a moment after a burst of writes. A read
 * that fails (the store unreadable for a moment) is reported and tried again later, backing
 * off; the busy flag last applied stays, since an unreadable tree is never taken for idle.
 */
export function hostBusyWatch(options: {
  /** Whether the tree is busy; undefined while there is no host thread to read. May throw. */
  busy(): boolean | undefined;
  apply(busy: boolean): void;
  report(error: unknown): void;
  after(ms: number, run: () => void): () => void;
  settleMs: number;
  retryMs: { first: number; most: number };
}) {
  let cancel: (() => void) | undefined;
  let retryMs = options.retryMs.first;
  let closed = false;
  const read = () => {
    cancel = undefined;
    if (closed) return;
    let busy: boolean | undefined;
    try {
      busy = options.busy();
    } catch (error) {
      options.report(error);
      cancel = options.after(retryMs, read);
      retryMs = Math.min(retryMs * 2, options.retryMs.most);
      return;
    }
    retryMs = options.retryMs.first;
    if (busy !== undefined) options.apply(busy);
  };
  return {
    /** The store was written: read once the burst settles (a pending read or retry covers it). */
    written(): void {
      if (closed || cancel) return;
      cancel = options.after(options.settleMs, read);
    },
    /** Read now, replacing any pending read. */
    now(): void {
      cancel?.();
      read();
    },
    close(): void {
      closed = true;
      cancel?.();
      cancel = undefined;
    },
  };
}
