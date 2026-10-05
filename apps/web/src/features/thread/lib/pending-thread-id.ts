/**
 * A thread started from this window that the daemon hasn't named yet is shown under
 * `pending:<commandId>` (its `thread.create` command). Such an id is never leased from the
 * daemon: there's nothing there to subscribe to until the receipt names the real thread.
 */
export function isPendingThread(threadId: string | undefined): boolean {
  return threadId?.startsWith("pending:") === true;
}

/** The daemon's thread id, or undefined for a pending one (nothing to lease yet). */
export function leasable(threadId: string): string | undefined {
  return isPendingThread(threadId) ? undefined : threadId;
}
