import type { ThreadListEntry } from "@ace/protocol";
import { automaticTarget } from "@ace/accounts/availability";
import { liveWindows, tightestWindow, type AccountView } from "./accounts.ts";

/** The parts of a listed thread that say which account it runs on and whether it is stuck. */
export type AccountThreadSource = Pick<
  ThreadListEntry,
  "id" | "status" | "live" | "execution" | "archivedAt" | "deletedAt"
>;

/** A thread as the accounts screen counts it. */
export interface AccountThread {
  id: string;
  /** The account instance it runs on, as the daemon reports it. */
  account: string;
  /** Hit its account's limit and waiting on it. */
  limited: boolean;
}

export interface AccountThreadCounts {
  /** Working, waiting on you or on something else: everything still in flight. */
  running: number;
  /** Stopped at the account's limit. */
  limited: number;
  /** The limited threads, to move elsewhere. */
  limitedIds: readonly string[];
}

const inFlight = new Set(["working", "needs_you", "waiting", "unresponsive"]);

/**
 * The account a listed thread runs on and whether it counts: archived and deleted threads and
 * finished ones don't; a thread with no account yet doesn't either.
 */
export function accountThread(entry: AccountThreadSource): AccountThread | undefined {
  if (entry.archivedAt !== undefined || entry.deletedAt !== undefined) return undefined;
  const account = entry.live?.account ?? entry.execution?.instanceId;
  if (!account) return undefined;
  const limited = entry.status.state === "limited";
  if (!limited && !inFlight.has(entry.status.state)) return undefined;
  return { id: entry.id, account, limited };
}

/** Running and limited threads per account id. Accounts with neither are absent. */
export function accountThreadCounts(
  threads: Iterable<AccountThread>,
): ReadonlyMap<string, AccountThreadCounts> {
  const counts = new Map<string, { running: number; limited: number; limitedIds: string[] }>();
  for (const thread of threads) {
    let entry = counts.get(thread.account);
    if (!entry) {
      entry = { running: 0, limited: 0, limitedIds: [] };
      counts.set(thread.account, entry);
    }
    if (thread.limited) {
      entry.limited++;
      entry.limitedIds.push(thread.id);
    } else entry.running++;
  }
  return counts;
}

/**
 * Percent left in the account's tightest window still in its period at `now`; undefined when it
 * reports none, since then there is nothing to measure.
 */
export function headroom(account: AccountView, now: number): number | undefined {
  const window = tightestWindow({ windows: liveWindows(account, now) });
  return window && 100 - window.usedPercent;
}

/**
 * Where a thread on account `fromId` moves when its account runs out: the account the daemon's
 * automatic recovery picks, the first other account of the same provider, in listed order, that
 * is available at `now`. Moving by hand names the same account, so both say the same thing.
 */
export function migrationTarget(
  accounts: readonly AccountView[],
  fromId: string,
  now: number,
): AccountView | undefined {
  const from = accounts.find((account) => account.id === fromId);
  return from && automaticTarget(accounts, from, now);
}
