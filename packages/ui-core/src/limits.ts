import { availability, blockedUntil, nearLimitPercent } from "@ace/accounts/availability";
import type { LimitPolicy } from "@ace/protocol";
import type { z } from "zod";
import { accountStatus } from "./provider-account-model.ts";
import { migrationTarget } from "./account-threads.ts";
import {
  accountDisplayName,
  liveWindows,
  tightestWindow,
  type AccountView,
  type QuotaWindowView,
} from "./accounts.ts";

/*
 * Usage limits as the composer, the header, Activity, toasts and Usage & accounts word them: how
 * close an account is to a limit, when it resets, which account has room, and what changed
 * between two `accounts.list` reads. Pure; callers pass the clock.
 */

/** From this share of a window used, an account is near its limit (the meters turn amber). */
export { nearLimitPercent };

/** "Claude Code · Personal". */
export function accountName(
  account: Pick<AccountView, "providerLabel" | "label" | "implicit" | "signedInAs">,
): string {
  return `${account.providerLabel} · ${accountDisplayName(account)}`;
}

/** "5h", "Day", "Week", "Month": a window's name where a meter has room for one word. */
export function quotaWindowShort(window: Pick<QuotaWindowView, "label">): string {
  switch (window.label) {
    case "5-hour":
      return "5h";
    case "Daily":
      return "Day";
    case "Weekly":
      return "Week";
    case "Monthly":
      return "Month";
    default:
      return window.label;
  }
}

/** Unknown until the account's CLI says it is signed in: nothing is claimed about its limits. */
export type LimitLevel = "ok" | "near" | "reached" | "unknown";

export interface AccountLimit {
  level: LimitLevel;
  /** The window still in its period that is closest to its limit; undefined when none is. */
  window: QuotaWindowView | undefined;
  /**
   * When a reached account can work again, as the daemon resumes it: the last reset among what
   * holds it. Undefined when any of those didn't say when it resets.
   */
  resetsAt: number | undefined;
}

const levels = {
  available: "ok",
  near_limit: "near",
  exhausted: "reached",
  logged_out: "unknown",
  unknown: "unknown",
} as const satisfies Record<AccountView["availability"], LimitLevel>;

/**
 * How close an account is to its limit at `now`, by the daemon's own availability rules over the
 * quota it reported: windows and limit errors whose reset has passed no longer hold it.
 */
export function accountLimit(account: AccountView, now: number): AccountLimit {
  const level = levels[availability(account.quota, now)];
  const window = tightestWindow({ windows: liveWindows(account, now) });
  const resetsAt =
    level === "reached" ? (blockedUntil(account.quota, now) ?? undefined) : undefined;
  return { level, window, resetsAt };
}

/** What a thread's limit notice knows about the account it ran out on. */
export interface LimitContext {
  /** "Codex · Team". */
  name: string;
  /** "Codex": to say no other account of it has room. */
  providerLabel: string;
  /** When the account can work again; undefined when what holds it didn't say. */
  resetsAt: number | undefined;
  /** Where Move sends the thread, as automatic recovery would; null when no account is available. */
  target: { id: string; name: string } | null;
}

/** The limit notice's account facts, from `accounts.list` and the account the thread runs on. */
export function limitContext(
  accounts: readonly AccountView[],
  accountId: string,
  now: number,
): LimitContext | undefined {
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) return undefined;
  const target = migrationTarget(accounts, account.id, now);
  return {
    name: accountName(account),
    providerLabel: account.providerLabel,
    resetsAt: accountLimit(account, now).resetsAt,
    target: target ? { id: target.id, name: accountName(target) } : null,
  };
}

/**
 * What happens to a thread when its account runs out, by the daemon's `threads.limitPolicy` for
 * that thread; `target` names the account automatic recovery would move it to.
 */
export function atLimitLine(
  policy: z.infer<typeof LimitPolicy> | undefined,
  target: string | undefined,
): string {
  switch (policy) {
    case "resume_at_reset":
      return "At the limit it waits and resumes when the window resets.";
    case "snooze_until_reset":
      return "At the limit it snoozes until the window resets.";
    case "migrate_now":
      return target
        ? `At the limit it moves to ${target}.`
        : "At the limit it moves to another account if one is available.";
    default:
      return "At the limit it stops until you choose what to do.";
  }
}

/** One provider's accounts at a glance: how many can take work and which has the most room. */
export interface ProviderHeadroom {
  provider: AccountView["provider"];
  acpAgentId: string | undefined;
  providerLabel: string;
  /** Signed-in accounts that report usage windows. */
  accounts: number;
  /** Those that aren't at a limit. */
  available: number;
  unreported: number;
  /** The available account with the most room, and the window that decides it. */
  best: { account: AccountView; left: number; window: QuotaWindowView } | undefined;
  /** The account at a limit that frees up first, when one says when. */
  nextReset: { account: AccountView; at: number } | undefined;
}

/**
 * Headroom per provider at `now`: every listed account counts, even without usage windows.
 * Usable accounts can work; only reported windows determine which has the most headroom.
 */
export function providerHeadroom(
  accounts: readonly AccountView[],
  now: number,
): ProviderHeadroom[] {
  const groups = new Map<string, { account: AccountView; limit: AccountLimit }[]>();
  for (const account of accounts) {
    const limit = accountLimit(account, now);
    let group = groups.get(account.providerLabel);
    if (!group) groups.set(account.providerLabel, (group = []));
    group.push({ account, limit });
  }
  return [...groups].map(([providerLabel, group]) => {
    let best: ProviderHeadroom["best"];
    let nextReset: ProviderHeadroom["nextReset"];
    let available = 0;
    let unreported = 0;
    for (const { account, limit } of group) {
      if (!account.windows.length) unreported++;
      if (!accountStatus(account, now).canRun && limit.level !== "reached") continue;
      if (limit.level === "reached") {
        if (limit.resetsAt !== undefined && (!nextReset || limit.resetsAt < nextReset.at))
          nextReset = { account, at: limit.resetsAt };
        continue;
      }
      available++;
      if (!limit.window) continue;
      const left = 100 - limit.window.usedPercent;
      if (!best || left > best.left) best = { account, left, window: limit.window };
    }
    const first = group[0]?.account;
    return {
      provider: first?.provider ?? "acp",
      acpAgentId: first?.acpAgentId,
      providerLabel,
      accounts: group.length,
      available,
      unreported,
      best,
      nextReset,
    };
  });
}

/** Something about an account's limits worth a toast. */
export type LimitChange =
  | { kind: "near"; key: string; account: AccountView; window: QuotaWindowView }
  | { kind: "reached"; key: string; account: AccountView; resetsAt: number | undefined }
  | { kind: "reset"; key: string; account: AccountView };

/** Each account's limit as of the reads so far, for the next read to compare with. */
export type LimitReading = ReadonlyMap<string, AccountLimit>;

/**
 * What changed since the previous reading, for an `accounts.list` read at `now`: an account that
 * crossed into near its limit, one that reached it, and one at its limit that the daemon says can
 * work again. Accounts seen for the first time are history, not news. An account whose state is
 * unknown (its CLI hasn't said it is signed in) is no news either way and keeps its last known
 * state, so only an affirmative reading says it recovered. Each change has a `key` naming the
 * window period it is about, so a caller can say it once even when a meter wobbles across the line.
 */
export function limitChanges(
  previous: LimitReading | undefined,
  accounts: readonly AccountView[],
  now: number,
): { changes: LimitChange[]; reading: LimitReading } {
  const reading = new Map<string, AccountLimit>();
  const changes: LimitChange[] = [];
  for (const account of accounts) {
    const was = previous?.get(account.id);
    const limit = accountLimit(account, now);
    if (limit.level === "unknown") {
      if (was) reading.set(account.id, was);
      continue;
    }
    reading.set(account.id, limit);
    if (!was || limit.level === was.level) continue;
    if (limit.level === "reached")
      changes.push({
        kind: "reached",
        key: `reached:${account.id}:${limit.resetsAt ?? ""}`,
        account,
        resetsAt: limit.resetsAt,
      });
    else if (was.level === "reached")
      changes.push({ kind: "reset", key: `reset:${account.id}:${was.resetsAt ?? ""}`, account });
    else if (limit.level === "near" && limit.window)
      changes.push({
        kind: "near",
        key: `near:${account.id}:${limit.window.id}:${limit.window.resetsAt ?? ""}`,
        account,
        window: limit.window,
      });
  }
  return { changes, reading };
}

/**
 * The next moment an account read could change by itself: the earliest future reset among the
 * windows and limit errors near or at their limit. Undefined when none is coming.
 */
export function nextLimitReset(accounts: readonly AccountView[], now: number): number | undefined {
  let next: number | undefined;
  const consider = (window: { usedPercent: number; resetsAt: number | null }) => {
    if (
      window.resetsAt !== null &&
      window.resetsAt > now &&
      window.usedPercent >= nearLimitPercent &&
      (next === undefined || window.resetsAt < next)
    )
      next = window.resetsAt;
  };
  for (const account of accounts) {
    for (const window of Object.values(account.quota.windows)) consider(window);
    if (account.quota.blockers.limitError) consider(account.quota.blockers.limitError);
  }
  return next;
}

/** A thread held at its account's limit, as Activity lists it. */
export interface LimitedThread {
  id: string;
  title: string;
  /** The account it ran out on, when the daemon names one. */
  account: string | undefined;
  /** When the thread itself says it can go on. */
  until: number | undefined;
}

/** Limited threads that share an account: when it frees up, and where they could go meanwhile. */
export interface LimitedGroup {
  accountId: string | undefined;
  /** "Codex · Team"; the bare id when `accounts.list` doesn't have it. */
  name: string;
  /** The earliest the threads can go on: their own resets, else the account's. */
  resetsAt: number | undefined;
  /** The account Move picks; null when none is available, undefined while accounts are unknown. */
  target: { id: string; name: string } | null | undefined;
  threads: LimitedThread[];
}

/** Limited threads grouped by account at `now`, in the order their accounts first appear. */
export function limitedGroups(
  threads: readonly LimitedThread[],
  accounts: readonly AccountView[] | undefined,
  now: number,
): LimitedGroup[] {
  const groups = new Map<string, LimitedGroup>();
  for (const thread of threads) {
    const key = thread.account ?? "";
    let group = groups.get(key);
    if (!group) {
      const context = thread.account && accounts && limitContext(accounts, thread.account, now);
      group = {
        accountId: thread.account,
        name: context ? context.name : (thread.account ?? "Account not reported"),
        resetsAt: context ? context.resetsAt : undefined,
        target: context ? context.target : undefined,
        threads: [],
      };
      groups.set(key, group);
    }
    group.threads.push(thread);
    if (
      thread.until !== undefined &&
      (group.resetsAt === undefined || thread.until < group.resetsAt)
    )
      group.resetsAt = thread.until;
  }
  return [...groups.values()];
}
