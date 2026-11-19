import type { DaemonConnection } from "../shared/contract.ts";
import { resumeDaemonAccount } from "./account-follow.ts";
import { followAppAccount, type AppAccountDeps } from "./account-write.ts";

/**
 * Everything the app does to this computer's daemon's ace account (ADR 0111), one at a time
 * and in order: following the app's sign-in or sign-out (`account-write.ts`) and handing the
 * session to a daemon that came up signed out (`account-follow.ts`). Each run reads the app's
 * saved session when it starts, so a slow run never lands after a newer one, and work already
 * waiting for the same change is not queued twice: the waiting run will read the newest state.
 */
export function accountSync(
  deps: AppAccountDeps & {
    /** The daemon connection this window uses now. */
    connection(): Promise<DaemonConnection>;
  },
) {
  let tail: Promise<unknown> = Promise.resolve();
  const waiting = new Map<string, Promise<void>>();
  const run = (key: string, work: (connection: DaemonConnection) => Promise<unknown>) => {
    const queued = waiting.get(key);
    if (queued) return queued;
    const next = tail.then(async () => {
      waiting.delete(key);
      await work(await deps.connection());
    });
    waiting.set(key, next);
    tail = next.catch(() => {});
    return next;
  };
  return {
    /** The app's session for `origin` changed: bring the daemon in line with it. */
    followApp: (origin: string) =>
      run(`app:${origin}`, (connection) => followAppAccount(connection, origin, deps)),
    /** The daemon started or restarted: hand it the app's session if it came up without one. */
    resume: () => run("resume", (connection) => resumeDaemonAccount(connection, deps)),
  };
}
