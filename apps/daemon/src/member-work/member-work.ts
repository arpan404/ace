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

/** The backend gave no answer at all: no TCP or TLS answer, or a timeout. */
export class BackendUnreachable extends Error {}

/**
 * What stopping one member tree came to: `stopped` (or `idle`, nothing in it ran) once every
 * local session is closed; `unconfirmed` when one may still be open; `remote_pending` when its
 * local part is down but a child on another host hasn't been confirmed ended there.
 */
export type TreeStop = "idle" | "stopped" | "unconfirmed" | "remote_pending";

/** How long one tree's stop may take in a pass before the pass moves on, leaving it pending. */
export const STOP_BOUND_MS = 30_000;

/**
 * A delegation to another host, recorded before it is sent (ADR 0209 §7). It carries the member
 * and how long the child may run there, which the target enforces on its own clock.
 */
export interface RemoteStart {
  member: { account: string; ttlMs: number };
  /** The target named the child. True when the tree was stopped meanwhile: stop the child now. */
  named(child: string): boolean;
  /** The target made no child, for certain. */
  rejected(): void;
  /** The answer was lost after the call may have arrived: kept until the target says. */
  ambiguous(): void;
  /** The call ended without being sent (refused here first): nothing to wait for. A no-op once it has an outcome. */
  notSent(): void;
}

/** How long after its deadline a host may still be tearing a member's child down. */
const childMarginMs = memberWorkTimes.pollMs + STOP_BOUND_MS;

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
  /** Names each remote start. */
  id(): string;
  /**
   * Asks a delegation's target, without making anything, whether it made the child: named, made
   * for certain no child (the request is withdrawn there), or still not known.
   */
  resolveRemoteStart?(delegation: string): Promise<{ child: string } | "rejected" | "unknown">;
  /** How long one tree's stop may take in a pass; `STOP_BOUND_MS` unless set. */
  stopBoundMs?: number;
  log?(error: Error): void;
}

export interface MemberWork {
  /** Whether `account` may run work on this host now (§7.1). False on a personal machine. */
  active(account: string): boolean;
  /** Whether a roster revoked `account` and no later one lifted it (§7.2). */
  revoked(account: string): boolean;
  /**
   * Whether `account`'s tree `root` may run work now (open a session, take input, answer a
   * request, delegate), holding its lease if so. Never past a lease that ran out, never while a
   * stop is under way, and never on a tree a stop ended: only `resume` clears that.
   */
  admit(account: string, root: string): boolean;
  /**
   * The owner's own proven input (the access policy's principal at command admission) resumes
   * tree `root` a stop ended, if they may run work and the stop is done. Nothing else clears a
   * stop: no engine continuation, retry, automation or agent input.
   */
  resume(account: string, root: string): boolean;
  /**
   * Records a delegation from tree `root` to another host before it is sent (`delegation` is
   * what's needed to ask its target later); none if refused.
   */
  remoteStart(account: string, root: string, delegation: string): RemoteStart | undefined;
  /**
   * A child another host's member tree made here: torn down at `ttlMs` from now on this
   * machine's own clock, whatever its source says or doesn't, and never renewed.
   */
  trackChild(thread: string, account: string, ttlMs: number): void;
  /** Whether such a child's time here has run out: nothing more of it runs. */
  childExpired(thread: string): boolean;
  /** A member tree settled on its own: its lease goes. */
  release(root: string): void;
  /** Why a member tree was stopped, until its owner resumes it. */
  stopReason(root: string): StopReason | undefined;
  /** Member trees whose stop isn't confirmed yet. */
  pendingStops(): string[];
  /**
   * Environment that makes a process of tree `root` start inside that tree's containment
   * (§7.3); undefined where there is none beyond the session's own process group.
   */
  launchEnv(account: string, root: string): Record<string, string> | undefined;
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
  /**
   * Trees whose stop is being settled now, and when that began: a later pass starts another
   * try for one only once this one has outlived the bound, so a hang never excludes it for good.
   */
  const settling = new Map<string, number>();
  /** Remote starts whose call is under way in this run; any other one's answer was lost. */
  const sending = new Set<string>();
  let cancelDeadline: (() => void) | undefined;
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

  function offlineMs(org: string) {
    return offlineAllowanceMs(store.policy(org)?.offlineMinutes, options.hostOfflineMinutes?.());
  }

  function mayRunNow(org: string, account: string) {
    return mayRun({
      account,
      roster: renewingRoster(org),
      revoked: held(org).revoked.has(account),
      now: now(),
      offlineMs: offlineMs(org),
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
   * Settles one pending stop: the tree torn down, its containment killed, its children on other
   * hosts confirmed ended there. Calling it fences the tree at once (`stopTree`'s synchronous
   * part); the rest is awaited. It counts only once all of that is positively confirmed. A child
   * on another host that is never confirmed (unreachable, unpaired), or a delegation whose answer
   * never came, counts as ended once the destination's own lease of it must have run out: the
   * offline allowance and a lease after the stop began.
   */
  async function settleOne(
    org: string,
    stop: { root: string; account: string; reason: StopReason; endedAt: number },
  ) {
    await resolveStarts(org, stop.root);
    // Both start now and run side by side, each bounded: processes are killed even while a
    // session close hangs, and neither holds the pass past the bound.
    const tree = bounded(
      options.stopTree(stop.root, stop.reason).catch((error: unknown): TreeStop => {
        log(error);
        return "unconfirmed";
      }),
      "unconfirmed" as TreeStop,
    );
    const killed = bounded(
      options.containment.kill(stop.account, stop.root).catch((error: unknown) => {
        log(error);
        return false;
      }),
      false,
    );
    const [result, gone] = await Promise.all([tree, killed]);
    const remote =
      (result !== "remote_pending" && store.remoteStarts(stop.root).length === 0) ||
      remoteBoundPassed(org, stop);
    if (result !== "unconfirmed" && gone && remote) store.confirmStop(stop.root);
  }

  /** How long a member's child may run on another host: the offline allowance and a lease. */
  function childTtlMs(org: string) {
    return offlineMs(org) + memberWorkTimes.leaseMs;
  }

  /**
   * Asks the target of each delegation from `root` whose answer was lost whether it made the
   * child. Named, it joins the tree's remote children with its teardown bound; refused for
   * certain, the start goes; otherwise it stays, and the stop with it.
   */
  async function resolveStarts(org: string, root: string) {
    for (const start of store.remoteStarts(root)) {
      if (sending.has(start.id) || !options.resolveRemoteStart) continue;
      const answer = await bounded(
        options.resolveRemoteStart(start.delegation).catch(() => "unknown" as const),
        "unknown" as const,
      );
      if (answer === "rejected") store.removeRemoteStart(start.id);
      else if (answer !== "unknown")
        store.nameRemoteChild(
          start.id,
          answer.child,
          org,
          root,
          now() + childTtlMs(org) + childMarginMs,
        );
    }
  }

  /**
   * Whether every child `root` made on other hosts has been torn down by its own host by now:
   * past the deadline that host enforces itself, and nothing whose answer was lost.
   */
  function remoteBoundPassed(_org: string, stop: { root: string }) {
    if (store.remoteStarts(stop.root).length > 0) return false;
    const bounds = store.remoteChildBounds(stop.root);
    const at = now();
    return bounds.length > 0 && bounds.every((bound) => at >= bound);
  }

  /** Tears down every child here whose deadline came, each bounded, retried until done. */
  async function enforceDeadlines() {
    const due = store.dueChildren(now());
    await Promise.all(
      due.map(async (thread) => {
        const result = await bounded(
          options.stopTree(thread, "deadline").catch((): TreeStop => "unconfirmed"),
          "unconfirmed" as TreeStop,
        );
        if (result === "stopped" || result === "idle") store.childTornDown(thread);
      }),
    );
    scheduleDeadline();
  }

  /** A timer for the next deadline here, so a child is torn down at it, not a pass later. */
  function scheduleDeadline() {
    cancelDeadline?.();
    const next = store.nextChildDeadline();
    if (closed || next === undefined) return;
    cancelDeadline = options.delay(
      () => {
        void serial(enforceDeadlines);
      },
      Math.max(0, next - now()),
    );
  }

  /** `work`'s answer, or `fallback` once the bound passes first. The work itself runs on. */
  function bounded<T>(work: Promise<T>, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const cancelTimer = options.delay(
        () => resolve(fallback),
        options.stopBoundMs ?? STOP_BOUND_MS,
      );
      void work.then((value) => {
        cancelTimer();
        resolve(value);
      });
    });
  }

  /**
   * Settles every stop of `org` still pending, the ones a pass just began and any an earlier
   * pass or run left. Every tree is fenced first, all at once; then each one's teardown runs on
   * its own, bounded, so one that hangs never holds back another or the next pass. One that
   * doesn't finish in time stays pending.
   */
  async function settleStops(org: string) {
    const bound = options.stopBoundMs ?? STOP_BOUND_MS;
    const at = now();
    const running = store
      .pendingStops(org)
      .filter((stop) => {
        const began = settling.get(stop.root);
        return began === undefined || at - began >= bound;
      })
      .map((stop) => {
        settling.set(stop.root, at);
        return settleOne(org, stop)
          .catch(log)
          .finally(() => {
            if (settling.get(stop.root) === at) settling.delete(stop.root);
          });
      });
    await Promise.all(running);
  }

  async function runPass() {
    // On every machine: a member's child here ends at its deadline, org host or not.
    await enforceDeadlines();
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

  function admit(account: string, root: string): boolean {
    const org = options.org();
    // An owned tree on a machine no organization holds: nothing vouches for its owner.
    if (org === undefined || !mayRunNow(org, account)) return false;
    if (store.pendingStops(org).some((stop) => stop.root === root)) return false;
    const at = now();
    const lease = store.lease(root);
    // A lease that ran out is never renewed: the next pass stops its tree.
    if (lease && lease.expiresAt <= at) return false;
    // A tree a stop ended waits for its owner's own input.
    if (!lease && store.stopReason(root) !== undefined) return false;
    store.hold(org, account, root, at, at + memberWorkTimes.leaseMs);
    return true;
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
    admit,
    resume(account, root) {
      const org = options.org();
      if (org === undefined || !mayRunNow(org, account)) return false;
      if (store.pendingStops(org).some((stop) => stop.root === root)) return false;
      const at = now();
      const lease = store.lease(root);
      if (lease && lease.expiresAt <= at) return false;
      store.hold(org, account, root, at, at + memberWorkTimes.leaseMs);
      return true;
    },
    remoteStart(account, root, delegation) {
      const org = options.org();
      if (org === undefined || !admit(account, root)) return undefined;
      const id = options.id();
      const ttlMs = childTtlMs(org);
      store.addRemoteStart(id, org, root, now(), delegation);
      sending.add(id);
      const stopped = () => store.stopReason(root) !== undefined || store.lease(root) === undefined;
      return {
        member: { account, ttlMs },
        notSent() {
          if (!sending.delete(id)) return;
          store.removeRemoteStart(id);
        },
        named(child) {
          sending.delete(id);
          store.nameRemoteChild(id, child, org, root, now() + ttlMs + childMarginMs);
          return stopped();
        },
        rejected() {
          sending.delete(id);
          store.removeRemoteStart(id);
        },
        ambiguous() {
          // Kept, now as a start whose answer was lost: the stop asks its target.
          sending.delete(id);
        },
      };
    },
    trackChild(thread, account, ttlMs) {
      store.addChildDeadline(thread, account, now() + ttlMs);
      scheduleDeadline();
    },
    childExpired(thread) {
      const deadline = store.childDeadline(thread);
      return deadline !== undefined && now() >= deadline.deadlineAt;
    },
    release: (root) => store.release(root),
    stopReason: (root) => store.stopReason(root),
    pendingStops() {
      const org = options.org();
      return org === undefined ? [] : store.pendingStops(org).map((stop) => stop.root);
    },
    launchEnv: (account, root) => options.containment.launchEnv(account, root),
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
      cancelDeadline?.();
      await chain;
    },
  };
}
