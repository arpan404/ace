/**
 * Safe lifecycle owner for production directory loads.
 *
 * Two different cancellations share one manager, and they must not be
 * confused:
 *
 * - retry: a timed-out `startup.load()` still runs (nothing can cancel it)
 *   and reconciles into the shared manager when it eventually settles. The
 *   retry queues behind it through the manager's serialization instead of
 *   duplicating owners, so a stale generation must never write React state
 *   and, critically, must never `disconnectAll`: that would tear down the
 *   newer generation's sockets.
 * - terminal disposal: the component unmounts mid-load. The late
 *   `startup.load()` finishes its pre-serialize steps (`ensureOutboxTables`,
 *   `grants.load`) and only then calls the serialized `manager.load()`, so it
 *   can open runtimes *after* phase-one cleanup's `disconnectAll` already
 *   ran. That leaks sockets on an abandoned manager.
 *
 * The owner tracks both: `begin()`/`isCurrent()` gate retry generations
 * (stale attempts stay silent), while `track()` registers the underlying
 * `startup.load()` promise and `dispose()` invalidates every generation and
 * hands the pending set back so the shell can drain it and disconnect last.
 * The pure module never touches the manager; `ProductionRoot` owns the
 * drain-and-disconnect shell.
 */

export interface LoadLifecycle {
  /** Claim the id for a new load attempt; all older ids go stale. */
  begin(): number;
  /** True only when `id` is the latest attempt and the owner is live. */
  isCurrent(id: number): boolean;
  /** True after terminal disposal (unmount). Never resets. */
  isDisposed(): boolean;
  /**
   * Register the underlying `startup.load()` promise (not the timeout race:
   * the race settles early while the orphan still runs). Removed on settle.
   */
  track<T>(work: Promise<T>): Promise<T>;
  /**
   * Terminal disposal: invalidate every generation and return the pending
   * snapshot the shell must drain before its final `disconnectAll`.
   */
  dispose(): readonly Promise<unknown>[];
}

export function createLoadLifecycle(): LoadLifecycle {
  let latest = 0;
  let disposed = false;
  const pending = new Set<Promise<unknown>>();
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isCurrent(id: number) {
      return !disposed && id === latest;
    },
    isDisposed() {
      return disposed;
    },
    track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      const remove = () => {
        pending.delete(work);
      };
      work.then(remove, remove);
      return work;
    },
    dispose() {
      disposed = true;
      latest += 1;
      return Array.from(pending);
    },
  };
}
