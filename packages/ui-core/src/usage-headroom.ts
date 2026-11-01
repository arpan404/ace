import type { AccountLimits, AccountWindow, ProviderLimits, UsageLimits } from "./usage-limits.ts";
import { formatCountdown } from "./time.ts";
import { joinNames } from "./join-names.ts";

/*
 * How much room each provider has, for the rail's Usage bars, its hover card and the Usage
 * page's Now line. Every figure is a share LEFT.
 *
 * Pooled session headroom: ace can start a new thread on whichever of a provider's accounts has
 * room, so a provider's headroom is its BEST account's usable session left. An account's usable
 * session left is its session window's share left, capped by its weekly window's (a fresh session
 * on an account whose week is spent can't take work). Accounts whose sign-in lapsed and windows
 * past their reset (their figure is unknown until the next reading) don't count. The best account
 * is used rather than a capacity-weighted mix because plans don't report capacity in one unit,
 * and one account with room is enough to start work.
 */

/** Under this share left a bar turns amber. */
export const lowHeadroomPercent = 20;

export type HeadroomTone = "ok" | "low" | "out";

export function headroomTone(left: number): HeadroomTone {
  if (left <= 0) return "out";
  return left < lowHeadroomPercent ? "low" : "ok";
}

export interface ProviderHeadroom {
  key: string;
  provider: ProviderLimits["provider"];
  acpAgentId: string | undefined;
  providerLabel: string;
  /** Pooled session left across its accounts; null when no account's session can be read. */
  sessionLeft: number | null;
  /** The account new threads start on (the default, else the first listed). */
  current: AccountLimits | undefined;
  /** The current account's usable session left; null when it can't be read. */
  currentLeft: number | null;
  /** The current account's session and weekly windows. */
  session: AccountWindow | undefined;
  weekly: AccountWindow | undefined;
  /** The account with the most usable session left. */
  best: AccountLimits | undefined;
  /** How many accounts it has. */
  accounts: number;
  /** While the pooled session is out: when the first account comes back. */
  backAt: number | null;
}

const sessionLabels = new Set(["Session (5h)", "Daily"]);

/**
 * The account's session window: its five-hour one, else its daily one, else its shortest. Past
 * its reset it still shows, but counts as unknown.
 */
export function sessionWindow(account: AccountLimits): AccountWindow | undefined {
  return (
    account.windows.find((window) => sessionLabels.has(window.label)) ??
    account.windows.find((window) => window.label !== "Weekly") ??
    account.windows[0]
  );
}

export function weeklyWindow(account: AccountLimits): AccountWindow | undefined {
  const session = sessionWindow(account);
  return account.windows.find((window) => window.label === "Weekly" && window !== session);
}

/** The binding windows of an account: its session and weekly ones that still read. */
function binding(account: AccountLimits): AccountWindow[] {
  if (account.signIn) return [];
  return [sessionWindow(account), weeklyWindow(account)].filter(
    (window): window is AccountWindow => window !== undefined && !window.stale,
  );
}

/** Usable session left on one account; null when its session can't be read. */
export function usableSessionLeft(account: AccountLimits): number | null {
  const session = sessionWindow(account);
  if (!session || session.stale || account.signIn) return null;
  return Math.min(...binding(account).map((window) => window.leftPercent));
}

/** When an account that is out takes work again: once every spent window has reset. */
function backAt(account: AccountLimits): number | null {
  const spent = binding(account).filter((window) => window.leftPercent <= 0);
  if (!spent.length || spent.some((window) => window.resetsAt === null)) return null;
  return Math.max(...spent.map((window) => window.resetsAt ?? 0));
}

/** Pooled headroom for one provider, from its accounts as the Usage page lists them. */
export function providerHeadroom(group: ProviderLimits): ProviderHeadroom {
  const current =
    group.accounts.find((entry) => entry.account.isDefault) ?? group.accounts[0] ?? undefined;
  let best: AccountLimits | undefined;
  let bestLeft: number | null = null;
  for (const entry of group.accounts) {
    const left = usableSessionLeft(entry);
    if (left !== null && (bestLeft === null || left > bestLeft)) {
      best = entry;
      bestLeft = left;
    }
  }
  const returns = group.accounts.flatMap((entry) => {
    const at = backAt(entry);
    return at === null ? [] : [at];
  });
  return {
    key: group.key,
    provider: group.provider,
    acpAgentId: group.acpAgentId,
    providerLabel: group.providerLabel,
    sessionLeft: bestLeft,
    current,
    currentLeft: current ? usableSessionLeft(current) : null,
    session: current ? sessionWindow(current) : undefined,
    weekly: current ? weeklyWindow(current) : undefined,
    best,
    accounts: group.accounts.length,
    backAt: bestLeft === 0 && returns.length ? Math.min(...returns) : null,
  };
}

export function usageHeadroom(limits: UsageLimits): ProviderHeadroom[] {
  return limits.providers.map(providerHeadroom);
}

/** One bar of the rail's Usage icon. */
export interface HeadroomBar {
  key: string;
  label: string;
  /** Pooled session left, 0–100. */
  left: number;
  tone: HeadroomTone;
}

/** The rail icon: at most four bars, most-used provider first; `empty` with nothing to show. */
export interface RailUsage {
  bars: HeadroomBar[];
  /** The icon's spoken name, which says the state in words. */
  label: string;
}

const railBars = 4;

/**
 * The rail's bars: one per provider used in the last seven days (tokens by provider kind), most
 * used first, at most four. Providers that can't be read are left out. Without usage figures
 * (`used` undefined, or nothing used this week), every provider with a reading shows, in the
 * page's order, so limits never hide behind a missing ranking.
 */
export function railUsage(
  headroom: readonly ProviderHeadroom[],
  used: ReadonlyMap<string, number> | undefined,
): RailUsage {
  const readable = headroom.filter((entry) => entry.sessionLeft !== null);
  const ranked =
    used && used.size > 0
    ? readable
        .filter((entry) => (used.get(entry.provider) ?? 0) > 0)
        .toSorted((a, b) => (used.get(b.provider) ?? 0) - (used.get(a.provider) ?? 0))
    : readable;
  const bars = ranked.slice(0, railBars).map((entry) => {
    const left = entry.sessionLeft ?? 0;
    return { key: entry.key, label: entry.providerLabel, left, tone: headroomTone(left) };
  });
  return { bars, label: railLabel(bars) };
}

function railLabel(bars: readonly HeadroomBar[]): string {
  if (!bars.length) return "Usage: no limits read yet";
  const parts = bars.map((bar, index) => {
    if (bar.left <= 0) return `${bar.label} out`;
    return index === 0 ? `${bar.label} ${bar.left}% of session left` : `${bar.label} ${bar.left}%`;
  });
  return `Usage: ${parts.join(", ")}`;
}

/** "about 40m", "about 2h", "about 3 days": a forecast, never more precise than it can be. */
export function approximately(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `about ${Math.max(5, Math.round(minutes / 5) * 5)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours}h`;
  const days = Math.round(hours / 24);
  return `about ${days} ${days === 1 ? "day" : "days"}`;
}

/** Text with the parts to set in bold, so every client draws the same sentence. */
export interface UsageLine {
  parts: { text: string; strong?: boolean }[];
  text: string;
}

const line = (...parts: (string | { text: string; strong: true })[]): UsageLine => {
  const pieces = parts.map((part) => (typeof part === "string" ? { text: part } : part));
  return { parts: pieces, text: pieces.map((part) => part.text).join("") };
};
const strong = (text: string) => ({ text, strong: true as const });

const readable = (headroom: readonly ProviderHeadroom[]) =>
  headroom.filter((entry) => entry.currentLeft !== null || entry.sessionLeft !== null);

/** Providers with no account that can take work, soonest back first. */
function outProviders(headroom: readonly ProviderHeadroom[]): ProviderHeadroom[] {
  return headroom
    .filter((entry) => entry.sessionLeft === 0)
    .toSorted((a, b) => (a.backAt ?? Infinity) - (b.backAt ?? Infinity));
}

/** The provider whose account for new threads has the least session left. */
export function tightestProvider(
  headroom: readonly ProviderHeadroom[],
): ProviderHeadroom | undefined {
  return readable(headroom).toSorted(
    (a, b) =>
      (a.currentLeft ?? a.sessionLeft ?? 100) - (b.currentLeft ?? b.sessionLeft ?? 100) ||
      (a.session?.runsOutAt ?? Infinity) - (b.session?.runsOutAt ?? Infinity),
  )[0];
}

function backIn(entry: ProviderHeadroom, now: number): string {
  return entry.backAt === null ? "" : formatCountdown(entry.backAt - now);
}

/**
 * The Usage page's Now line. Who is out on every account and when they're back; else whose
 * account for new threads is out; else "You have room on every provider" and the tightest one,
 * with its forecast when it runs out before its reset. Undefined with nothing read.
 */
export function usageNow(
  headroom: readonly ProviderHeadroom[],
  now: number,
): UsageLine | undefined {
  const out = outProviders(headroom);
  const [first, ...rest] = out;
  if (first) {
    const names = joinNames(out.map((entry) => entry.providerLabel));
    const verb = out.length === 1 ? "is" : "are";
    const firstBack = backIn(first, now);
    if (!rest.length)
      return line(
        strong(first.providerLabel),
        ` is out on ${first.accounts > 1 ? "every account" : "its account"}`,
        firstBack ? `; it's back in ${firstBack}.` : ".",
      );
    const backs = out
      .filter((entry) => entry.backAt !== null)
      .map(
        (entry, index) =>
          `${entry.providerLabel}${index === 0 ? " is back" : ""} in ${backIn(entry, now)}`,
      );
    return line(`${names} ${verb} out.${backs.length ? ` ${joinNames(backs)}.` : ""}`);
  }
  const stopped = readable(headroom).find((entry) => entry.currentLeft === 0 && entry.current);
  if (stopped?.current) {
    const back = stopped.session?.resetsAt;
    return line(
      strong(stopped.providerLabel),
      `'s ${stopped.current.account.label} account is out`,
      back ? `; it's back in ${formatCountdown(back - now)}.` : ".",
    );
  }
  const tight = tightestProvider(headroom);
  if (!tight) return undefined;
  const left = tight.currentLeft ?? tight.sessionLeft ?? 0;
  const runsOut = tight.session?.runsOutAt;
  return line(
    "You have room on every provider. ",
    strong(tight.providerLabel),
    ` is the tightest: ${left}% of the session left`,
    runsOut ? `, out in ${approximately(runsOut - now)} at this pace.` : ".",
  );
}

/** The hover card's one sentence about the tightest provider. */
export function headroomSentence(headroom: readonly ProviderHeadroom[], now: number): string {
  const [first] = outProviders(headroom);
  if (first) {
    const back = backIn(first, now);
    return `${first.providerLabel} is out${back ? `; it's back in ${back}` : ""}.`;
  }
  const tight = tightestProvider(headroom);
  if (!tight) return "No limits read yet.";
  const resets = tight.session?.resetsAt;
  const resetPart = resets ? `; it resets in ${formatCountdown(resets - now)}` : "";
  const runsOut = tight.session?.runsOutAt;
  if (runsOut)
    return `${tight.providerLabel}'s session runs out in ${approximately(runsOut - now)} at this pace${resetPart}.`;
  const left = tight.currentLeft ?? tight.sessionLeft ?? 0;
  return `${tight.providerLabel} is the tightest, with ${left}% of the session left${resetPart}.`;
}
