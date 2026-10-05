import type { LimitPolicy } from "@ace/protocol";
import type { z } from "zod";
import { headroom, migrationTarget } from "./account-threads.ts";
import {
  blockingReset,
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
export const nearLimitPercent = 85;

/** "Claude Code · Personal". */
export function accountName(account: Pick<AccountView, "providerLabel" | "label">): string {
  return `${account.providerLabel} · ${account.label}`;
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

export type LimitLevel = "ok" | "near" | "reached";

export interface AccountLimit {
  level: LimitLevel;
  /** The window closest to its limit; undefined when the provider reports none. */
  window: QuotaWindowView | undefined;
  /** When a reached account can work again: the earliest reset of an exhausted window. */
  resetsAt: number | undefined;
}

/**
 * How close an account is to its limit: reached when the daemon says it is exhausted or a window
 * is full, near when the daemon says so or a window is past `nearLimitPercent`.
 */
export function accountLimit(account: AccountView): AccountLimit {
  const window = tightestWindow(account);
  const used = window?.usedPercent ?? 0;
  if (account.availability === "exhausted" || used >= 100)
    return { level: "reached", window, resetsAt: blockingReset(account) };
  const level = account.availability === "near_limit" || used >= nearLimitPercent ? "near" : "ok";
  return { level, window, resetsAt: undefined };
}

/** What a thread's limit notice knows about the account it ran out on. */
export interface LimitContext {
  /** "Codex · Team". */
  name: string;
  /** "Codex": to say no other account of it has room. */
  providerLabel: string;
  /** When the account can work again, if any exhausted window says. */
  resetsAt: number | undefined;
  /** Where Move sends the thread; null when no other account of the provider has room. */
  target: { id: string; name: string } | null;
}

/** The limit notice's account facts, from `accounts.list` and the account the thread runs on. */
export function limitContext(
  accounts: readonly AccountView[],
  accountId: string,
): LimitContext | undefined {
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) return undefined;
  const target = migrationTarget(accounts, account.id);
  return {
    name: accountName(account),
    providerLabel: account.providerLabel,
    resetsAt: accountLimit(account).resetsAt,
    target: target ? { id: target.id, name: accountName(target) } : null,
  };
}

/**
 * What happens to a thread when its account runs out, by the daemon's `threads.limitPolicy`;
 * `target` names the account a move would pick.
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
        : "At the limit it moves to the account with the most room.";
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
  /** The available account with the most room, and the window that decides it. */
  best: { account: AccountView; left: number; window: QuotaWindowView } | undefined;
  /** The account at a limit that frees up first, when one does. */
  nextReset: { account: AccountView; at: number } | undefined;
}

/**
 * Headroom per provider, in the order accounts are listed: only signed-in accounts whose provider
 * reports windows count, since an account that reports nothing has no headroom to compare.
 */
export function providerHeadroom(accounts: readonly AccountView[]): ProviderHeadroom[] {
  const groups = new Map<string, AccountView[]>();
  for (const account of accounts) {
    if (!account.signedIn || !account.windows.length) continue;
    groups.set(account.providerLabel, [...(groups.get(account.providerLabel) ?? []), account]);
  }
  return [...groups].map(([providerLabel, group]) => {
    let best: ProviderHeadroom["best"];
    let nextReset: ProviderHeadroom["nextReset"];
    let available = 0;
    for (const account of group) {
      const limit = accountLimit(account);
      if (limit.level === "reached") {
        if (limit.resetsAt !== undefined && (!nextReset || limit.resetsAt < nextReset.at))
          nextReset = { account, at: limit.resetsAt };
        continue;
      }
      available++;
      const left = headroom(account);
      if (limit.window && (!best || left > best.left))
        best = { account, left, window: limit.window };
    }
    return {
      provider: group[0]?.provider ?? "acp",
      acpAgentId: group[0]?.acpAgentId,
      providerLabel,
      accounts: group.length,
      available,
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

/**
 * What changed between two reads of `accounts.list`: an account that crossed into near its limit,
 * one that reached it, and one at its limit that can work again. Accounts seen only once are
 * history, not news. Each change has a `key` naming the window period it is about, so a caller
 * can say it once even when a meter wobbles across the line.
 */
export function limitChanges(
  previous: readonly AccountView[] | undefined,
  next: readonly AccountView[],
): LimitChange[] {
  if (!previous) return [];
  const before = new Map(previous.map((account) => [account.id, accountLimit(account)]));
  const changes: LimitChange[] = [];
  for (const account of next) {
    const was = before.get(account.id);
    if (!was || !account.signedIn) continue;
    const now = accountLimit(account);
    if (now.level === was.level) continue;
    if (now.level === "reached")
      changes.push({
        kind: "reached",
        key: `reached:${account.id}:${now.resetsAt ?? ""}`,
        account,
        resetsAt: now.resetsAt,
      });
    else if (was.level === "reached")
      changes.push({ kind: "reset", key: `reset:${account.id}:${was.resetsAt ?? ""}`, account });
    else if (now.level === "near" && now.window)
      changes.push({
        kind: "near",
        key: `near:${account.id}:${now.window.id}:${now.window.resetsAt ?? ""}`,
        account,
        window: now.window,
      });
  }
  return changes;
}

/**
 * The next moment an account read could change by itself: the earliest future reset among the
 * windows near or at their limit. Undefined when none is coming.
 */
export function nextLimitReset(accounts: readonly AccountView[], now: number): number | undefined {
  let next: number | undefined;
  for (const account of accounts)
    for (const window of account.windows)
      if (
        window.resetsAt !== null &&
        window.resetsAt > now &&
        window.usedPercent >= nearLimitPercent &&
        (next === undefined || window.resetsAt < next)
      )
        next = window.resetsAt;
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
  /** The account Move picks; null when none has room, undefined while accounts are unknown. */
  target: { id: string; name: string } | null | undefined;
  threads: LimitedThread[];
}

/** Limited threads grouped by account, in the order their accounts first appear. */
export function limitedGroups(
  threads: readonly LimitedThread[],
  accounts: readonly AccountView[] | undefined,
): LimitedGroup[] {
  const groups = new Map<string, LimitedGroup>();
  for (const thread of threads) {
    const key = thread.account ?? "";
    let group = groups.get(key);
    if (!group) {
      const context = thread.account && accounts && limitContext(accounts, thread.account);
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
