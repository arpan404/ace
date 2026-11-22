import { verifyOrgPolicy, verifyOrgRoster, type GrantKeySet } from "@ace/account-grant";
import type { AceOrgPolicyVersion, AceOrgRoster } from "@ace/protocol/ace-org";
import type { ProcessLease } from "@ace/provider-kit/process";
import type { Containment } from "./containment.ts";
import {
  memberWorkTimes,
  mayRun,
  offlineAllowanceMs,
  reconcile,
  revocationChanges,
  rosterStep,
  type HeldRoster,
  type Lease,
  type StopReason,
} from "./rules.ts";
import { rosterMembers, type MemberWorkStore } from "./store.ts";

/*
 * Members' work on an org host (ADR 0209 §7): the roster it polls, durable revocations, each
 * member tree's execution lease, and stopping a member's work when a lease ends or the member
 * is revoked. On a personal machine (no organization) it does nothing: no roster is asked for,
 * no lease is held and nothing is stopped.
 *
 * What the rest of the daemon calls (the seam with the access policy, ADR 0209 §3–§5):
 * `active` (may this member run work here now), `hold`/`release` (a member tree starts or
 * settles), `contain`/`processLease` (a member's process joins their containment) and `stop`
 * (stop this member's work).
 */

export interface MemberWorkOptions {
  store: MemberWorkStore;
  /** The organization this machine answers to now; undefined on a personal machine. */
  org(): string | undefined;
  /** This host's relay id, which its roster must name. */
  host(): string | undefined;
  /** The roster from the backend, as served; throws when the backend can't be reached. */
  fetchRoster(org: string, host: string): Promise<AceOrgRoster>;
  /** The backend's published grant keys, which sign rosters and policies. */
  keys(): GrantKeySet;
  /**
   * Stops one member tree: every part interrupted, none left reading done. False when nothing
   * in it was running (it settled on its own), so there was nothing to stop.
   */
  stopTree(root: string, reason: StopReason): Promise<boolean>;
  containment: Containment;
  now(): number;
  /** Runs `callback` after `ms`; the function it answers cancels it. */
  delay(callback: () => void, ms: number): () => void;
  /** The host's own ceiling on the offline allowance, in minutes; only narrows the policy's. */
  hostOfflineMinutes?(): number | undefined;
  log?(error: Error): void;
}

export interface MemberWork {
  /** Whether `account` may run work on this host now (§7.1). False on a personal machine. */
  active(account: string): boolean;
  /** Whether a roster revoked `account` and no later one showed them active (§7.2). */
  revoked(account: string): boolean;
  /** A member tree starts or resumes: its lease, if its owner may run work. False refuses it. */
  hold(account: string, root: string): boolean;
  /** A member tree settled on its own: its lease goes. */
  release(root: string): void;
  /** Why a member tree was stopped, until its owner resumes it. */
  stopReason(root: string): StopReason | undefined;
  /** Moves a member's process into their containment (§7.3). */
  contain(account: string, pid: number): Promise<boolean>;
  /** A spawn lease that contains the process it brackets, for provider-kit's spawns. */
  processLease(account: string): ProcessLease;
  /** Stops all of `account`'s work: their trees interrupted, their contained processes killed. */
  stop(account: string, reason?: StopReason): Promise<void>;
  /** Hears each account a roster newly revoked, after it is stored. */
  onRevoked(listener: (account: string) => void): () => void;
  /** Takes a roster the backend served: refused unless it verifies, is this host's and is newer. */
  takeRoster(roster: AceOrgRoster): "taken" | "refreshed" | "refused";
  /** Keeps a verified policy version's offline allowance (§7.1, §8). */
  policySeen(policy: AceOrgPolicyVersion): void;
  /** One reconciliation pass now (§7.2). */
  pass(): Promise<void>;
  /** Fetches the roster now, then runs a pass. */
  sync(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** `threads.offline_minutes` from a policy body, read leniently: anything else is no setting. */
function policyOfflineMinutes(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("threads" in parsed)) return undefined;
    const threads: unknown = parsed.threads;
    if (typeof threads !== "object" || threads === null || !("offline_minutes" in threads))
      return undefined;
    const minutes: unknown = threads.offline_minutes;
    return typeof minutes === "number" && Number.isFinite(minutes) ? minutes : undefined;
  } catch {
    return undefined;
  }
}

export function memberWork(options: MemberWorkOptions): MemberWork {
  const { store } = options;
  const listeners = new Set<(account: string) => void>();
  let cached: { org: string; roster: HeldRoster | undefined; revoked: Set<string> } | undefined;
  let chain: Promise<void> = Promise.resolve();
  let cancel: (() => void) | undefined;
  let closed = false;
  const log = (error: unknown) =>
    options.log?.(error instanceof Error ? error : new Error(String(error)));

  /** What this host holds for `org`, read from disk once and kept current after. */
  function held(org: string) {
    if (cached?.org !== org)
      cached = {
        org,
        roster: store.roster(org),
        revoked: new Set(store.revokedAccounts(org)),
      };
    return cached;
  }

  function offlineMs(org: string) {
    return offlineAllowanceMs(store.policy(org)?.offlineMinutes, options.hostOfflineMinutes?.());
  }

  function mayRunNow(org: string, account: string) {
    const state = held(org);
    return mayRun({
      account,
      roster: state.roster,
      revoked: state.revoked.has(account),
      now: options.now(),
      offlineMs: offlineMs(org),
    });
  }

  /** One at a time: a pass never overlaps another or a roster's intake. */
  function serial(run: () => Promise<void>): Promise<void> {
    const next = chain.then(run).catch(log);
    chain = next;
    return next;
  }

  /** Stops `leases` (all one member's or a pass's), then kills what each owner has left running. */
  async function stopLeases(org: string, leases: readonly (Lease & { reason: StopReason })[]) {
    const owners = new Map<string, StopReason>();
    for (const lease of leases) {
      // Interrupted first, so the tree records a deliberate stop, then its processes go.
      const stopped = await options.stopTree(lease.root, lease.reason).catch((error: unknown) => {
        log(error);
        return true;
      });
      if (stopped) store.end(lease.root, lease.reason, options.now());
      else store.release(lease.root);
      owners.set(lease.account, lease.reason);
    }
    for (const [account, reason] of owners)
      if (reason === "revoked" || store.leases(org, account).length === 0)
        await options.containment.kill(account).catch(log);
  }

  async function runPass() {
    const org = options.org();
    if (org === undefined) return;
    const state = held(org);
    const { renew, stop } = reconcile({
      now: options.now(),
      leases: store.leases(org),
      revoked: (account) => state.revoked.has(account),
      mayRun: (account) => mayRunNow(org, account),
    });
    store.renew(renew);
    await stopLeases(org, stop);
  }

  function takeRoster(answer: AceOrgRoster): "taken" | "refreshed" | "refused" {
    const org = options.org();
    const host = options.host();
    if (org === undefined || host === undefined) return "refused";
    let statement;
    try {
      statement = verifyOrgRoster(answer.statement, options.keys(), answer.body);
    } catch (error) {
      log(error);
      return "refused";
    }
    if (statement.org !== org || statement.host !== host) return "refused";
    const state = held(org);
    const step = rosterStep(state.roster, statement);
    if (step === "refuse") return "refused";
    const members = rosterMembers(answer.body);
    const known = new Set([...(state.roster?.members.keys() ?? []), ...store.leaseOwners(org)]);
    const changes = revocationChanges({ members }, known);
    const now = options.now();
    const fresh = store.takeRoster(
      {
        org,
        version: statement.version,
        at: statement.at,
        body: answer.body,
        statement: answer.statement,
      },
      changes,
      now,
    );
    state.roster = { org, version: statement.version, at: statement.at, receivedAt: now, members };
    for (const account of changes.clear) state.revoked.delete(account);
    for (const account of changes.revoke) state.revoked.add(account);
    for (const account of fresh)
      for (const listener of listeners)
        try {
          listener(account);
        } catch (error) {
          log(error);
        }
    return step === "take" ? "taken" : "refreshed";
  }

  async function poll() {
    const org = options.org();
    const host = options.host();
    if (org === undefined || host === undefined) return;
    try {
      takeRoster(await options.fetchRoster(org, host));
    } catch (error) {
      // Offline: work keeps running on the last roster, within the allowance.
      log(error);
    }
    await runPass();
  }

  async function contain(account: string, pid: number): Promise<boolean> {
    if (options.org() === undefined) return false;
    return options.containment.contain(account, pid);
  }

  function schedule() {
    cancel?.();
    if (closed) return;
    cancel = options.delay(() => {
      void serial(poll).finally(schedule);
    }, memberWorkTimes.pollMs);
  }

  return {
    active(account) {
      const org = options.org();
      return org !== undefined && mayRunNow(org, account);
    },
    revoked(account) {
      const org = options.org();
      return org !== undefined && held(org).revoked.has(account);
    },
    hold(account, root) {
      const org = options.org();
      if (org === undefined || !mayRunNow(org, account)) return false;
      const now = options.now();
      store.hold(org, account, root, now, now + memberWorkTimes.leaseMs);
      return true;
    },
    release: (root) => store.release(root),
    stopReason: (root) => store.stopReason(root),
    contain,
    processLease(account) {
      return {
        preparing() {},
        spawned: (pid) => {
          void contain(account, pid).catch(log);
        },
      };
    },
    stop(account, reason = "stopped") {
      return serial(async () => {
        const org = options.org();
        if (org === undefined) return;
        await stopLeases(
          org,
          store.leases(org, account).map((lease) => Object.assign(lease, { reason })),
        );
        await options.containment.kill(account).catch(log);
      });
    },
    onRevoked(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    takeRoster,
    policySeen(policy) {
      const org = options.org();
      if (org === undefined || policy.org !== org || policy.statement === undefined) return;
      let statement;
      try {
        statement = verifyOrgPolicy(policy.statement, options.keys(), policy.body);
      } catch (error) {
        log(error);
        return;
      }
      if (statement.org !== org) return;
      store.putPolicy(org, statement.version, policyOfflineMinutes(policy.body));
    },
    pass: () => serial(runPass),
    sync: () => serial(poll),
    async start() {
      // From what is stored first, offline: a revocation seen before a restart stops work now.
      await serial(runPass);
      await serial(poll);
      schedule();
    },
    async close() {
      closed = true;
      cancel?.();
      await chain;
    },
  };
}
