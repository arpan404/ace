import type { LoadLifecycle } from "./load-lifecycle.ts";

/**
 * One ordered ownership teardown per startup generation.
 *
 * A production startup generation owns four things that must release in
 * order: the in-flight `startup.load()` orphans (drain first, so a late
 * orphan cannot open runtimes after cleanup), the manager's sockets
 * (`disconnectAll` second), the pending lock writes (`flush` third) and the
 * SQLite handle (`closeDb` last, while the loads that need it are gone).
 *
 * Retry staleness and terminal disposal share this helper so the two paths
 * can never run concurrently against one generation: the first caller wins
 * and every later caller awaits the same promise. Disconnect and close stay
 * best-effort so a failing step never skips the steps behind it, but a
 * failed lock flush is rethrown after the close so durable lock-write errors
 * reach the caller instead of vanishing. A double teardown must never
 * double-close the database.
 */
export interface StartupTeardownDeps {
  readonly owner: LoadLifecycle;
  // eslint-disable-next-line no-unused-vars
  disconnectAll(): Promise<void>;
  flush(): Promise<void>;
  closeDb(): Promise<void>;
}

export interface StartupTeardown {
  readonly settled: boolean;
  teardown(): Promise<void>;
}

export function createStartupTeardown(deps: StartupTeardownDeps): StartupTeardown {
  let settled = false;
  let promise: Promise<void> | null = null;
  return {
    get settled() {
      return settled;
    },
    teardown(): Promise<void> {
      if (promise !== null) return promise;
      settled = true;
      promise = (async () => {
        const pending = deps.owner.dispose();
        if (pending.length > 0) await Promise.allSettled(pending);
        await deps.disconnectAll().catch(() => undefined);
        // Lock writes are durable state, not best-effort: a failed flush
        // must reach the caller instead of vanishing. Still close the
        // database first so the handle never leaks, then rethrow.
        let flushError: unknown = null;
        try {
          await deps.flush();
        } catch (error) {
          flushError = error;
        }
        await deps.closeDb().catch(() => undefined);
        if (flushError !== null) throw flushError;
      })();
      return promise;
    },
  };
}
