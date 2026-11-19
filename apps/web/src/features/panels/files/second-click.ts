/** Two clicks this close together on the same file are a double click. */
const doubleClickMs = 500;

/**
 * The last file one click previewed, per client and thread. A click that previews a file swaps
 * the tab it came from for the file's tab, which mounts a fresh tree, so a double click's second
 * click lands on a new row and the browser never sends that row a `dblclick`. The tree asks
 * here instead: a second click on the same file soon after is the double click that keeps it.
 */
const picks = new WeakMap<object, Map<string, { path: string; at: number }>>();

export function isSecondClick(owner: object, threadId: string, path: string, at: number): boolean {
  let byThread = picks.get(owner);
  if (!byThread) {
    byThread = new Map();
    picks.set(owner, byThread);
  }
  const last = byThread.get(threadId);
  const second = last !== undefined && last.path === path && at - last.at < doubleClickMs;
  if (second) byThread.delete(threadId);
  else byThread.set(threadId, { path, at });
  return second;
}
