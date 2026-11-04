import type { MachineAccountStatus } from "@ace/protocol";
import type { DaemonConnection, DaemonStatus } from "../shared/contract.ts";
import { handAccountToDaemon, readDaemonAccount } from "./account-handover.ts";

/** A handover to make: the app's session for `origin`, unless `unlessOtherThan` says otherwise. */
export type HandoverPlan = {
  origin: string;
  token: string;
  /**
   * The daemon's lapsed session belonged to this account. Hand over only when the app's session
   * is the same account; a different one would switch the machine's account unasked.
   */
  sameAccountAs?: string;
};

/**
 * Whether the app should hand its ace session to this computer's daemon, given the daemon's
 * account status and the app's saved sessions by origin. Never when the daemon is signed in
 * (to this account or another: the app never signs a daemon out or switches it), or when the
 * app has no session, or several and none for the daemon's own origin.
 */
export function planHandover(
  daemon: MachineAccountStatus,
  saved: Readonly<Record<string, string>>,
): HandoverPlan | undefined {
  if (daemon.signedIn) return undefined;
  const origins = Object.keys(saved);
  const origin =
    daemon.origin !== undefined && saved[daemon.origin] !== undefined
      ? daemon.origin
      : daemon.origin === undefined && origins.length === 1
        ? origins[0]
        : undefined;
  const token = origin === undefined ? undefined : saved[origin];
  if (origin === undefined || token === undefined) return undefined;
  return { origin, token, ...(daemon.account ? { sameAccountAs: daemon.account.id } : {}) };
}

export interface FollowDeps {
  /** The app's saved ace sessions, by origin. */
  saved(): Promise<Readonly<Record<string, string>>>;
  /** The account id an app session belongs to, from the account backend. */
  accountOf(origin: string, token: string): Promise<string>;
  send?: typeof fetch;
}

/**
 * Brings this computer's daemon to the app's account when it came up signed out: at app start,
 * after the daemon restarts, or after it was signed out elsewhere while the app stayed signed in.
 * Resolves with whether a session was handed over. A remote daemon is never asked or given one.
 */
export async function resumeDaemonAccount(
  connection: DaemonConnection,
  deps: FollowDeps,
): Promise<boolean> {
  const send = deps.send ?? fetch;
  const daemon = await readDaemonAccount(connection, send);
  if (!daemon) return false;
  const plan = planHandover(daemon, await deps.saved());
  if (!plan) return false;
  if (
    plan.sameAccountAs !== undefined &&
    (await deps.accountOf(plan.origin, plan.token)) !== plan.sameAccountAs
  )
    return false;
  await handAccountToDaemon(connection, plan.origin, plan.token, send);
  return true;
}

/**
 * Runs `resume` once the daemon is running, and again each time it comes back (a restart, or
 * running after any other state). One run at a time: a start seen during a run runs it once
 * more afterwards. A failure waits for the next start.
 */
export function followDaemonAccount(
  runtime: {
    current(): DaemonStatus;
    onStatus(listener: (status: DaemonStatus) => void): () => void;
  },
  resume: () => Promise<unknown>,
): () => void {
  let running = false;
  let restarts = -1;
  let busy = false;
  let again = false;
  const run = () => {
    busy = true;
    again = false;
    void resume()
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (again) run();
      });
  };
  const seen = (status: DaemonStatus) => {
    const up = status.state === "running";
    const fresh = up && (!running || status.restarts !== restarts);
    running = up;
    if (up) restarts = status.restarts;
    if (!fresh) return;
    if (busy) again = true;
    else run();
  };
  const stop = runtime.onStatus(seen);
  seen(runtime.current());
  return stop;
}
