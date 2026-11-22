import { verifyOrgPolicy, verifyOrgRoster, type GrantKeySet } from "@ace/account-grant";
import type { AceOrgPolicyVersion, AceOrgRoster } from "@ace/protocol/ace-org";
import type { Containment } from "./containment.ts";
import {
  leaseClock,
  memberWorkTimes,
  mayRun,
  offlineAllowanceMs,
  reconcile,
  revocationChanges,
  rosterStep,
  type HeldRoster,
  type Reachability,
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
 * `active` (may this member run work here now), `admit` (may this member tree run new work
 * now; holds its lease), `launchEnv` (start a member's process inside their containment) and
 * `stop` (stop this member's work). `gate.ts` applies them at every execution entry point.
 */

/** The backend gave no answer at all: the network, a timeout, its edge failing. */
export class BackendUnreachable extends Error {}

/** What stopping one member tree came to. */
export type TreeStop = "idle" | "stopped" | "unconfirmed";

export interface MemberWorkOptions {
  store: MemberWorkStore;
  /** The organization this machine answers to now; undefined on a personal machine. */
  org(): string | undefined;
  /** This host's relay id, which its roster must name. */
  host(): string | undefined;
  /**
   * The roster from the backend, as served. Throws `BackendUnreachable` when there was no
   * answer; anything else thrown is an answer that refused this host.
   */
  fetchRoster(org: string, host: string): Promise<AceOrgRoster>;
  /** The backend's published grant keys, which sign rosters and policies. */
  keys(): GrantKeySet;
  /**
   * Stops one member tree: every part fenced, interrupted and recorded as failed, its remote
   * children told to stop. `idle` when nothing in it ran; `unconfirmed` when its sessions may
   * still be open.
   */
  stopTree(root: string, reason: StopReason): Promise<TreeStop>;
  containment: Containment;
  /** The wall clock. */
  wall(): number;
  /** A monotonic clock, in milliseconds. */
  monotonic(): number;
  /** Runs `callback` after `ms`; the function it answers cancels it. */
  delay(callback: () => void, ms: number): () => void;
  /** The host's own ceiling on the offline allowance, in minutes; only narrows the policy's. */
  hostOfflineMinutes?(): number | undefined;
  log?(error: Error): void;
}

export interface MemberWork {
  /** Whether `account` may run work on this host now (§7.1). False on a personal machine. */
  active(account: string): boolean;
  /** Whether a roster revoked `account` and no later one lifted it (§7.2). */
  revoked(account: string): boolean;
  /**
   * Whether `account`'s tree `root` may run new work now, holding its lease if so. A tree a stop
   * ended takes new work again only from its owner (`person`), and not while the stop is still
   * under way; queued, automated and agent work (`other`) waits for that.
   */
  admit(account: string, root: string, origin: "person" | "other"): boolean;
  /** A member tree settled on its own: its lease goes. */
  release(root: string): void;
  /** Why a member tree was stopped, until its owner resumes it. */
  stopReason(root: string): StopReason | undefined;
  /** Member trees whose stop isn't confirmed yet. */
  pendingStops(): string[];
  /**
   * Environment that makes a member's provider process start inside their containment (§7.3);
   * undefined where there is none beyond the session's own process group.
   */
  launchEnv(account: string): Record<string, string> | undefined;
  /** Stops all of `account`'s work: their trees, then their contained processes. */
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
  const clock = leaseClock({
    wall: options.wall,
    monotonic: options.monotonic,
    highWater: store.highWater(),
  });
  const now = () => clock.now();
  const listeners = new Set<(account: string) => void>();
  let cached:
    | { org: string; roster: HeldRoster | undefined; revoked: Map<string, number> }
    | undefined;
  let reachability: Reachability = "unknown";
  let chain: Promise<void> = Promise.resolve();
  let cancel: (() => void) | undefined;
  let closed = false;
  const log = (error: unknown) =>
    options.log?.(error instanceof Error ? error : new Error(String(error)));

  /** What this host holds for `org`, read from disk once and kept current after. */
  function held(org: string) {
    if (cached?.org !== org)
      cached = { org, roster: store.roster(org), revoked: store.revocations(org) };
    return cached;
  }

  /**
   * The roster leases may renew on: none from before this run's start when the clock went back
   * across the restart, since how long the host was down is unknown.
   */
  function renewingRoster(org: string) {
    const roster = held(org).roster;
    if (!roster || clock.trusted || roster.receivedAt >= clock.startedAt) return roster;
    return undefined;
  }

  function mayRunNow(org: string, account: string) {
    return mayRun({
      account,
      roster: renewingRoster(org),
      revoked: held(org).revoked.has(account),
      now: now(),
      offlineMs: offlineAllowanceMs(
        store.policy(org)?.offlineMinutes,
        options.hostOfflineMinutes?.(),
      ),
      reachability,
    });
  }

  /** One at a time: a pass never overlaps another or a roster's intake. */
  function serial(run: () => Promise<void>): Promise<void> {
    const next = chain.then(run).catch(log);
    chain = next;
    return next;
  }

  /**
   * Finishes every stop of `org` still pending, the ones a pass just began and any an earlier
   * pass or run left: each tree torn down, then its owner's contained processes killed when
   * the owner is revoked or has no live tree left. A stop counts only once both are confirmed;
   * otherwise it stays pending for the next pass.
   */
  async function settleStops(org: string) {
    const byOwner = new Map<string, { root: string; reason: StopReason }[]>();
    for (const stop of store.pendingStops(org))
      byOwner.set(stop.account, [...(byOwner.get(stop.account) ?? []), stop]);
    for (const [account, stops] of byOwner) {
      const results = new Map<string, TreeStop>();
      for (const stop of stops)
        results.set(
          stop.root,
          await options.stopTree(stop.root, stop.reason).catch((error: unknown): TreeStop => {
            log(error);
            return "unconfirmed";
          }),
        );
      const kill =
        stops.some((stop) => stop.reason === "revoked") || store.leases(org, account).length === 0;
      const killed = kill
        ? await options.containment.kill(account).catch((error: unknown) => {
            log(error);
            return false;
          })
        : true;
      if (!killed) continue;
      // Idle counts as torn down: nothing of the tree runs, whether it settled before or a
      // previous try already stopped it.
      for (const [root, result] of results) if (result !== "unconfirmed") store.confirmStop(root);
    }
  }

  async function runPass() {
    const org = options.org();
    if (org === undefined) return;
    const state = held(org);
    const at = now();
    const { renew, stop } = reconcile({
      now: at,
      leases: store.leases(org),
      revoked: (account) => state.revoked.has(account),
      mayRun: (account) => mayRunNow(org, account),
    });
    store.renew(renew);
    store.beginStops(stop, at);
    store.recordTime(at);
    await settleStops(org);
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
      reachability = "refused";
      return "refused";
    }
    const state = held(org);
    const signed = {
      epoch: statement.epoch,
      version: statement.version,
      digest: statement.body_sha256,
      at: statement.at,
    };
    if (
      statement.org !== org ||
      statement.host !== host ||
      rosterStep(state.roster, signed) === "refuse"
    ) {
      reachability = "refused";
      return "refused";
    }
    const step = rosterStep(state.roster, signed);
    const members = rosterMembers(answer.body);
    const known = new Set([...(state.roster?.members.keys() ?? []), ...store.leaseOwners(org)]);
    const changes = revocationChanges({ members, at: statement.at }, known, state.revoked);
    const receivedAt = now();
    const fresh = store.takeRoster(
      { org, ...signed, body: answer.body, statement: answer.statement },
      changes,
      receivedAt,
    );
    state.roster = { org, ...signed, receivedAt, members };
    state.revoked = store.revocations(org);
    reachability = "ok";
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
      // Only no answer at all earns the offline allowance; an answer that refused earns none.
      reachability = error instanceof BackendUnreachable ? "unreachable" : "refused";
      log(error);
    }
    await runPass();
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
    admit(account, root, origin) {
      const org = options.org();
      // An owned tree on a machine no organization holds: nothing vouches for its owner.
      if (org === undefined || !mayRunNow(org, account)) return false;
      if (store.pendingStops(org).some((stop) => stop.root === root)) return false;
      const at = now();
      const lease = store.lease(root);
      // A lease that ran out is never renewed: the next pass stops its tree.
      if (lease && lease.expiresAt <= at) return false;
      if (!lease && store.stopReason(root) !== undefined && origin !== "person") return false;
      store.hold(org, account, root, at, at + memberWorkTimes.leaseMs);
      return true;
    },
    release: (root) => store.release(root),
    stopReason: (root) => store.stopReason(root),
    pendingStops() {
      const org = options.org();
      return org === undefined ? [] : store.pendingStops(org).map((stop) => stop.root);
    },
    launchEnv: (account) => options.containment.launchEnv(account),
    stop(account, reason = "stopped") {
      return serial(async () => {
        const org = options.org();
        if (org === undefined) return;
        store.beginStops(
          store.leases(org, account).map((lease) => ({ root: lease.root, reason })),
          now(),
        );
        await settleStops(org);
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
      // From what is stored first, offline: a revocation seen before a restart, or a stop it
      // didn't finish, is acted on now.
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
