import { z } from "zod";
import type { AccountLimits, AccountWindow, ProviderLimits, UsageLimits } from "./usage-limits.ts";
import { formatCountdown } from "./time.ts";

/*
 * How much room each provider has, for the rail's Usage bars and its hover card. Every figure is
 * a share LEFT.
 *
 * Pooled session headroom: ace can start a new thread on whichever of a provider's accounts has
 * room, so a provider's headroom is its BEST account's usable session left. An account's usable
 * session left is its session window's share left, capped by its weekly window's (a fresh session
 * on an account whose week is spent can't take work). Accounts whose sign-in lapsed don't count; a
 * session past its reset since its last reading counts as fresh. The best account
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

export interface PooledHeadroom {
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

/** A week-long window: the account's own week, or a model's ("Weekly · Fable"). */
const weekly = (window: AccountWindow) =>
  window.label === "Weekly" || window.label.startsWith("Weekly ·");

/**
 * The account's session window: its five-hour one, else its daily one, else its shortest window
 * that isn't a week (a monthly quota). None when it reports only weeks: some plans (Claude's
 * Ultra) have no session limit, and a week never stands in for one. Past its reset it still
 * shows, but counts as unknown.
 */
export function sessionWindow(account: AccountLimits): AccountWindow | undefined {
  return (
    account.windows.find((window) => sessionLabels.has(window.label)) ??
    account.windows.find((window) => !weekly(window))
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

/**
 * Usable session left on one account; null when its session can't be read. A session whose reset
 * passed since its last reading is fresh: any use since would have been reported.
 */
export function usableSessionLeft(account: AccountLimits): number | null {
  const session = sessionWindow(account);
  if (!session || account.signIn) return null;
  return Math.min(
    session.stale ? 100 : session.leftPercent,
    ...binding(account).map((window) => window.leftPercent),
  );
}

/** When an account that is out takes work again: once every spent window has reset. */
function backAt(account: AccountLimits): number | null {
  const spent = binding(account).filter((window) => window.leftPercent <= 0);
  if (!spent.length || spent.some((window) => window.resetsAt === null)) return null;
  return Math.max(...spent.map((window) => window.resetsAt ?? 0));
}

/** Pooled headroom for one provider, from its accounts as the Usage page lists them. */
export function pooledHeadroom(group: ProviderLimits): PooledHeadroom {
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

export function usageHeadroom(limits: UsageLimits): PooledHeadroom[] {
  return limits.providers.map(pooledHeadroom);
}

/** One bar of the rail's Usage icon: one account's week. */
export interface HeadroomBar {
  key: string;
  /** "Claude Code · Work"; the provider alone when it has one account. */
  label: string;
  /** The account's weekly room left, 0–100. */
  left: number;
  tone: HeadroomTone;
  /** What `left` measures, for the spoken name: "week", "day", or the window's own name. */
  span: string;
}

/** The rail icon: one bar per account, at most four; none with nothing read. */
export interface RailUsage {
  bars: HeadroomBar[];
  /** The icon's spoken name, which says the state in words. */
  label: string;
  /** The accounts the bars draw, in their order: the card lists the same ones. */
  accounts: AccountLimits[];
  /** Whether they are the person's pins, rather than the accounts used most this week. */
  pinned: boolean;
}

/** The most accounts the rail shows, so the most that can be pinned to it. */
export const railBars = 4;

/** Accounts pinned to the rail on a device, by account id, in the order pinned. */
export const RailPins = z.array(z.string().min(1).max(512)).max(railBars);
export type RailPins = z.infer<typeof RailPins>;


/**
 * The window a rail bar shows: the account's weekly one, else its longest (Gemini's daily quota,
 * Cursor's monthly one). Weekly rather than session, because nearly every account reports a week,
 * so the icon can show four accounts, and the week is what lasts.
 */
export function railWindow(account: AccountLimits): AccountWindow | undefined {
  return weeklyWindow(account) ?? account.windows.at(-1);
}

/** What the rail's bars measure, a device setting: each account's week (the default) or session. */
export const RailMeasure = z.enum(["week", "session"]);
export type RailMeasure = z.infer<typeof RailMeasure>;

/** The account's usable session left, as a bar; null when its session can't be read. */
function sessionRoom(account: AccountLimits): { left: number; span: string } | null {
  const left = usableSessionLeft(account);
  return left === null ? null : { left, span: "session" };
}

/** The account's room in its rail window; null when it can't be read. Past its reset: fresh. */
function railLeft(account: AccountLimits): { left: number; span: string } | null {
  const window = railWindow(account);
  if (!window || account.signIn) return null;
  const span =
    window.label === "Weekly"
      ? "week"
      : window.label === "Daily"
        ? "day"
        : window.label.toLowerCase();
  return { left: window.stale ? 100 : window.leftPercent, span };
}

/**
 * The rail's bars: one per account with a reading, so one account draws one bar and more accounts
 * draw more, up to four. The accounts used most in the last seven days come first (`used`: tokens
 * by account id); accounts not used this week fill the rest, in the page's order. Each bar is that
 * account's weekly room left (`railWindow`), or with `measure` "session", its usable session left
 * (its session capped by its week). Accounts whose sign-in lapsed are left out.
 */
export function railUsage(
  limits: UsageLimits,
  used: ReadonlyMap<string, number> | undefined,
  measure: RailMeasure = "week",
  pins: RailPins = [],
): RailUsage {
  const readable = limits.providers.flatMap((group) =>
    group.accounts.flatMap((entry) => {
      const room = measure === "session" ? sessionRoom(entry) : railLeft(entry);
      if (room === null) return [];
      const label =
        group.accounts.length > 1
          ? `${group.providerLabel} · ${entry.account.label}`
          : group.providerLabel;
      const bar = { key: entry.key, label, left: room.left, span: room.span, tone: headroomTone(room.left) };
      return [{ entry, bar }];
    }),
  );
  const pinnedHere = pins.flatMap((id) => readable.find((each) => each.entry.account.id === id) ?? []);
  // Pins, in the order pinned; with none here, the accounts used most this week, the rest in the
  // page's order, up to four.
  const tokens = (each: { entry: AccountLimits }) => used?.get(each.entry.account.id) ?? 0;
  const shown = pinnedHere.length
    ? pinnedHere
    : readable
        .map((each, index) => ({ each, index }))
        .toSorted((a, b) => tokens(b.each) - tokens(a.each) || a.index - b.index)
        .slice(0, railBars)
        .map(({ each }) => each);
  const bars = shown.map((each) => each.bar);
  return {
    bars,
    label: railLabel(bars),
    accounts: shown.map((each) => each.entry),
    pinned: pinnedHere.length > 0,
  };
}

/** "Usage: Claude Code · Personal 59% of the week left, Codex 78%, Gemini CLI 29% of the day". */
function railLabel(bars: readonly HeadroomBar[]): string {
  if (!bars.length) return "Usage: no limits read yet";
  // The first figure says what it measures; later ones over the same span are just figures.
  let said: string | undefined;
  const parts = bars.map((bar) => {
    if (bar.left <= 0) return `${bar.label} out for the ${bar.span}`;
    if (said === bar.span) return `${bar.label} ${bar.left}%`;
    const first = said === undefined;
    said ??= bar.span;
    return first
      ? `${bar.label} ${bar.left}% of the ${bar.span} left`
      : `${bar.label} ${bar.left}% of the ${bar.span}`;
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

const readable = (headroom: readonly PooledHeadroom[]) =>
  headroom.filter((entry) => entry.currentLeft !== null || entry.sessionLeft !== null);

/** Providers with no account that can take work, soonest back first. */
function outProviders(headroom: readonly PooledHeadroom[]): PooledHeadroom[] {
  return headroom
    .filter((entry) => entry.sessionLeft === 0)
    .toSorted((a, b) => (a.backAt ?? Infinity) - (b.backAt ?? Infinity));
}

/** The provider whose account for new threads has the least session left. */
export function tightestProvider(headroom: readonly PooledHeadroom[]): PooledHeadroom | undefined {
  return readable(headroom).toSorted(
    (a, b) =>
      (a.currentLeft ?? a.sessionLeft ?? 100) - (b.currentLeft ?? b.sessionLeft ?? 100) ||
      (a.session?.runsOutAt ?? Infinity) - (b.session?.runsOutAt ?? Infinity),
  )[0];
}

function backIn(entry: PooledHeadroom, now: number): string {
  return entry.backAt === null ? "" : formatCountdown(entry.backAt - now);
}

/**
 * The one thing the card's rows can't say: a provider whose every account is out, and when the
 * first comes back. A window that runs out says so in its own row. Undefined otherwise.
 */
export function headroomAlert(
  headroom: readonly PooledHeadroom[],
  now: number,
): { text: string; tone: "out" } | undefined {
  const [first] = outProviders(headroom);
  if (!first) return undefined;
  const back = backIn(first, now);
  return {
    text: `${first.providerLabel} is out${back ? `; it's back in ${back}` : ""}.`,
    tone: "out",
  };
}
