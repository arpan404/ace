import type { ProviderKind } from "@ace/protocol";
import type { AccountView } from "./accounts.ts";
import { formatCountdown } from "./time.ts";
import { joinNames } from "./join-names.ts";

/*
 * The Usage page's limits, account first: each provider's accounts, each listed once with its
 * windows beneath it. Every figure is what is LEFT (100 − used), so it never reads two ways.
 */

/** An account as the Usage page lists it, with the environment (daemon) that reported it. */
export interface UsageAccount {
  account: AccountView;
  environment: string;
  environmentId?: string | undefined;
}

/** How a window's use compares with the time it has run. */
export type LimitPace = "ahead" | "on_pace" | "behind";

/** One of an account's windows. */
export interface AccountWindow {
  id: string;
  /** "Session (5h)", "Weekly", "Weekly · GPT-5.3-Codex-Spark". */
  label: string;
  leftPercent: number;
  resetsAt: number | null;
  pace: LimitPace | undefined;
  /** When the provider last reported this window. */
  observedAt: number;
  /** Its reset has passed since that reading: what is left now is unknown until the next one. */
  stale: boolean;
}

export interface AccountLimits {
  key: string;
  account: AccountView;
  /** The machine it was read on; "Mac and Studio" for one account signed in on both. */
  environment: string;
  /** The machine whose reading is shown (the freshest), which a banked reset goes through. */
  environmentId?: string | undefined;
  /** Every machine that reported this account, by name. */
  environments: string[];
  /** Banked resets the provider reports; undefined when it doesn't report them. */
  bankedResets: number | undefined;
  bankedExpiresAt: number | null;
  /** The plan the provider reports ("Pro"); undefined when it doesn't say. */
  plan: string | undefined;
  /** Why its usage can't be read and what to do ("Sign in again in Gemini CLI"). */
  signIn: string | undefined;
  /** Shortest window first, as the account lists them. */
  windows: AccountWindow[];
  /**
   * The provider has a 5-hour window for some plans but reported none for this account, so the
   * page can say so instead of leaving it out silently.
   */
  noSessionWindow: boolean;
}

export interface ProviderLimits {
  key: string;
  provider: ProviderKind;
  acpAgentId: string | undefined;
  providerLabel: string;
  accounts: AccountLimits[];
}

export interface UsageLimits {
  providers: ProviderLimits[];
  /** Providers with accounts but no live limits, by name: one quiet line. */
  quiet: string[];
  /**
   * Accounts of one provider on several machines that ace can't tell apart or together (no
   * sign-in reported), so each machine's is listed: "Can't tell whether the Claude Code
   * accounts on Mac and Studio are the same; each is listed."
   */
  unsure: string[];
}

const minute = 60_000;

/** "62% left" from a used share; never below 0 or above 100. */
export function leftPercent(usedPercent: number): number {
  return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)));
}

/** "4h 59m", "6d 12h": the time until a reset. Null when not reported. */
export function resetCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  return formatCountdown(resetsAt - now);
}

/**
 * Whether a window is being used faster than it runs: `ahead` when the used share leads the
 * elapsed share by more than a tenth, `behind` when it trails by as much. Needs the window's
 * length and reset time; otherwise undefined.
 */
export function limitPace(
  usedPercent: number,
  resetsAt: number | null,
  durationMins: number | undefined,
  now: number,
): LimitPace | undefined {
  if (resetsAt === null || durationMins === undefined || durationMins <= 0) return undefined;
  const length = durationMins * minute;
  const elapsed = Math.min(1, Math.max(0, 1 - (resetsAt - now) / length));
  const used = usedPercent / 100;
  if (used - elapsed > 0.1) return "ahead";
  if (elapsed - used > 0.1) return "behind";
  return "on_pace";
}

const sessionProviders = new Set(["codex", "claude"]);

/** The same login on another machine: provider, agent and who it is signed in as. */
function identity(account: AccountView): string | undefined {
  const who = account.signedInAs?.trim().toLowerCase();
  return who ? `${account.provider}:${account.acpAgentId ?? ""}:${who}` : undefined;
}

const freshness = (account: AccountView) =>
  Math.max(account.quota.observedAt, ...account.windows.map((window) => window.observedAt ?? 0));

/**
 * Group accounts with reported windows by provider, in the order they first appear. Windows past
 * their reset stay, marked stale, so an old reading reads as old instead of vanishing. A
 * provider whose accounts report no window joins the quiet line instead. One login reported by
 * several machines is listed once, with the freshest reading and every machine's name; its
 * limits are the provider's, not the machine's, so they are never counted twice.
 */
export function usageLimits(accounts: readonly UsageAccount[], now: number): UsageLimits {
  const groups = new Map<string, ProviderLimits>();
  const silent = new Map<string, string>();
  const shared = new Map<string, { entry: AccountLimits; machines: Set<string> }>();
  /** Per provider: the machines with an account listed, and whether any had no sign-in. */
  const spread = new Map<
    string,
    { label: string; machines: Map<string, string>; unnamed: boolean }
  >();
  for (const { account, environment, environmentId } of accounts) {
    const key = `${account.provider}:${account.acpAgentId ?? ""}`;
    const windows = account.windows;
    // An account whose login lapsed is listed with what to do, never with a guess at its limits.
    if (!windows.length && !account.usageSignIn && !account.resetCredits?.available) {
      if (!groups.has(key)) silent.set(key, account.providerLabel);
      continue;
    }
    silent.delete(key);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        provider: account.provider,
        acpAgentId: account.acpAgentId,
        providerLabel: account.providerLabel,
        accounts: [],
      };
      groups.set(key, group);
    }
    const machine = environmentId ?? environment;
    const reach = spread.get(key) ?? {
      label: account.providerLabel,
      machines: new Map<string, string>(),
      unnamed: false,
    };
    reach.machines.set(machine, environment);
    const who = identity(account);
    if (!who) reach.unnamed = true;
    spread.set(key, reach);
    const entry = accountLimits(account, environment, environmentId, now);
    const twin = who ? shared.get(who) : undefined;
    if (twin && !twin.machines.has(machine)) {
      const environments = [...twin.entry.environments, environment];
      const kept = freshness(account) > freshness(twin.entry.account) ? entry : twin.entry;
      const merged = {
        ...kept,
        key: twin.entry.key,
        environments,
        environment: joinNames(environments),
      };
      group.accounts[group.accounts.indexOf(twin.entry)] = merged;
      twin.entry = merged;
      twin.machines.add(machine);
      continue;
    }
    group.accounts.push(entry);
    if (who && !twin) shared.set(who, { entry, machines: new Set([machine]) });
  }
  const unsure = [...spread.values()].flatMap((reach) =>
    reach.unnamed && reach.machines.size > 1
      ? [
          `Can't tell whether the ${reach.label} accounts on ${joinNames([...reach.machines.values()])} are the same; each is listed.`,
        ]
      : [],
  );
  return {
    providers: [...groups.values()],
    quiet: [...new Set(silent.values())],
    unsure,
  };
}

function accountLimits(
  account: AccountView,
  environment: string,
  environmentId: string | undefined,
  now: number,
): AccountLimits {
  const windows = account.windows;
  return {
    key: `${environmentId ?? environment}\0${account.id}`,
    environmentId,
    account,
    environment,
    environments: [environment],
    bankedResets: account.resetCredits?.available,
    bankedExpiresAt: account.resetCredits?.nextExpiresAt ?? null,
    plan: account.plan,
    signIn: account.usageSignIn,
    windows: windows.map((window) => {
      const stale = window.resetsAt !== null && window.resetsAt <= now;
      return {
        id: window.id,
        label: window.label,
        leftPercent: leftPercent(window.usedPercent),
        resetsAt: window.resetsAt,
        pace: stale
          ? undefined
          : limitPace(window.usedPercent, window.resetsAt, window.windowDurationMins, now),
        observedAt: window.observedAt ?? account.quota.observedAt,
        stale,
      };
    }),
    noSessionWindow:
      sessionProviders.has(account.provider) &&
      !windows.some((window) => window.label === "Session (5h)"),
  };
}
