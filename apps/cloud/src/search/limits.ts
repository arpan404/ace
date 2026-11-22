/**
 * ace search's limits (ADR 0210 §4), as pure rules: what each search counts against, when each
 * period ends, and what a full counter says. The counts themselves live in D1 (counters.ts).
 */

/** Ceramic's list price through AI Gateway: $0.25 per 1,000 searches. */
export const DOLLARS_PER_SEARCH = 0.25 / 1000;

export type SearchLimits = {
  /** Searches an account may make in a UTC month. */
  monthly: number;
  /** The monthly allowance while the account is new. */
  newAccountMonthly: number;
  /** How many days an account counts as new. */
  newAccountDays: number;
  /** Searches an account may make in a UTC day. */
  daily: number;
  /** Searches one machine (a grant's subject, a credential's host) may make in a month and a day. */
  machineMonthly: number;
  machineDaily: number;
  /** Searches one caller address may make in a UTC day, whichever accounts it signs in as. */
  addressDaily: number;
  /** Searches the whole service may make in a UTC day: the spend breaker. */
  globalDaily: number;
};

export const DEFAULT_LIMITS: SearchLimits = {
  monthly: 1000,
  newAccountMonthly: 100,
  newAccountDays: 7,
  daily: 100,
  machineMonthly: 500,
  machineDaily: 60,
  addressDaily: 300,
  globalDaily: Math.floor(5 / DOLLARS_PER_SEARCH),
};

/** The Worker vars that set the limits; unset or unreadable ones keep their default. */
export type LimitVars = Partial<
  Record<
    | "ACE_SEARCH_MONTHLY"
    | "ACE_SEARCH_NEW_ACCOUNT_MONTHLY"
    | "ACE_SEARCH_NEW_ACCOUNT_DAYS"
    | "ACE_SEARCH_DAILY"
    | "ACE_SEARCH_MACHINE_MONTHLY"
    | "ACE_SEARCH_MACHINE_DAILY"
    | "ACE_SEARCH_ADDRESS_DAILY"
    | "ACE_SEARCH_DAILY_DOLLARS",
    string
  >
>;

function count(text: string | undefined, fallback: number): number {
  if (text === undefined || !/^\s*\d{1,9}\s*$/.test(text)) return fallback;
  return Number(text);
}

function dollars(text: string | undefined): number | undefined {
  if (text === undefined || !/^\s*\d{1,7}(\.\d{1,4})?\s*$/.test(text)) return undefined;
  return Number(text);
}

export function readLimits(vars: LimitVars): SearchLimits {
  const d = DEFAULT_LIMITS;
  const spend = dollars(vars.ACE_SEARCH_DAILY_DOLLARS);
  return {
    monthly: count(vars.ACE_SEARCH_MONTHLY, d.monthly),
    newAccountMonthly: count(vars.ACE_SEARCH_NEW_ACCOUNT_MONTHLY, d.newAccountMonthly),
    newAccountDays: count(vars.ACE_SEARCH_NEW_ACCOUNT_DAYS, d.newAccountDays),
    daily: count(vars.ACE_SEARCH_DAILY, d.daily),
    machineMonthly: count(vars.ACE_SEARCH_MACHINE_MONTHLY, d.machineMonthly),
    machineDaily: count(vars.ACE_SEARCH_MACHINE_DAILY, d.machineDaily),
    addressDaily: count(vars.ACE_SEARCH_ADDRESS_DAILY, d.addressDaily),
    globalDaily:
      spend === undefined ? d.globalDaily : Math.floor(spend / DOLLARS_PER_SEARCH + 1e-9),
  };
}

/** A UTC day or month: its name in the counters and when it ends. */
export type Period = { name: string; ends: number };

export function dayOf(now: number): Period {
  const at = new Date(now);
  return {
    name: at.toISOString().slice(0, 10),
    ends: Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1),
  };
}

export function monthOf(now: number): Period {
  const at = new Date(now);
  return {
    name: at.toISOString().slice(0, 7),
    ends: Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1),
  };
}

/** Why a search was refused: the `error` code Spade reads. */
export type Refusal =
  | "search_busy"
  | "repeated_query"
  | "resting"
  | "monthly_spent"
  | "daily_spent"
  | "machine_spent"
  | "address_spent";

/** The one plain sentence each refusal says (ADR 0210 §4). */
export const REASONS: Record<Refusal, string> = {
  search_busy: "Too many searches this minute.",
  repeated_query: "That search was just asked several times.",
  resting: "ace search is resting today.",
  monthly_spent: "You've used this month's ace searches. They come back on the 1st.",
  daily_spent: "You've used today's ace searches. They come back tomorrow.",
  machine_spent: "This machine has used its ace searches for now.",
  address_spent: "Too many ace searches from this network today.",
};

/** One counter a search takes: at most `cap` in `period`, refused as `refusal`. */
export type Counter = { scope: string; period: Period; cap: number; refusal: Refusal };

/** Who is searching: the account, the machine it searches from, and the caller's address. */
export type Searcher = { account: string; machine: string; address: string };

/**
 * Every counter one search takes. When several are full, the first listed is the one reported:
 * the breaker, then the account's, the machine's and the address's.
 */
export function countersFor(
  who: Searcher,
  limits: SearchLimits,
  now: number,
  isNew: boolean,
): Counter[] {
  const day = dayOf(now);
  const month = monthOf(now);
  return [
    { scope: "global", period: day, cap: limits.globalDaily, refusal: "resting" },
    {
      scope: `account:${who.account}`,
      period: month,
      cap: isNew ? Math.min(limits.newAccountMonthly, limits.monthly) : limits.monthly,
      refusal: "monthly_spent",
    },
    { scope: `account:${who.account}`, period: day, cap: limits.daily, refusal: "daily_spent" },
    {
      scope: `machine:${who.machine}`,
      period: month,
      cap: limits.machineMonthly,
      refusal: "machine_spent",
    },
    {
      scope: `machine:${who.machine}`,
      period: day,
      cap: limits.machineDaily,
      refusal: "machine_spent",
    },
    {
      scope: `address:${who.address}`,
      period: day,
      cap: limits.addressDaily,
      refusal: "address_spent",
    },
  ];
}

/** Whether an account first seen at `firstSeen` (undefined: never) is still new at `now`. */
export function isNewAccount(firstSeen: number | undefined, now: number, days: number): boolean {
  return firstSeen === undefined || now - firstSeen < days * 86_400_000;
}

/** Whole seconds from `now` to `ends`, at least 1. */
export function secondsUntil(ends: number, now: number): number {
  return Math.max(1, Math.ceil((ends - now) / 1000));
}
