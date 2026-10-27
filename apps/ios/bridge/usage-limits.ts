import type { ClientCore } from "@ace/client";
import {
  accountView,
  resetCountdown,
  staleReadingMs,
  usageAccounts,
  usageCoverage,
  usageLimits,
} from "@ace/ui-core";
import { AccountSummary, type AccountResetOutcome } from "@ace/protocol/accounts";
import { z } from "zod";
import { host } from "./host.ts";
import { preview } from "./presentation.ts";
import { UsageMachineReach, type UsageCoverageView } from "./usage-report.ts";

/*
 * The Usage screen's Limits view across the machines in scope: each provider's accounts with
 * what is left of every window, in the web Usage page's words (`usageLimits` in `@ace/ui-core`).
 * Each machine answers `usage.accounts` with its own accounts; Swift hands them all to
 * `usage.combineLimits`, which lists one login signed in on several machines once.
 */

/** One machine's accounts as it last recorded them. */
export const UsageAccountsRequest = z.object({ type: z.literal("usage.accounts") });
/** One machine asks its CLIs for current limits (no model turn), then answers its accounts. */
export const UsageRefreshRequest = z.object({ type: z.literal("usage.refreshLimits") });
export interface UsageAccountsReply {
  type: "usage.accounts";
  accounts: z.infer<typeof AccountSummary>[];
}
export const UsageLimitsCombineRequest = z.object({
  type: z.literal("usage.combineLimits"),
  machines: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        name: z.string().min(1).max(128),
        reach: UsageMachineReach,
        accounts: z.array(AccountSummary).max(256).optional(),
      }),
    )
    .min(1)
    .max(32),
});
export type UsageLimitsCombineRequest = z.infer<typeof UsageLimitsCombineRequest>;
/** Spend one banked reset on a Codex account; the same key retries the same attempt. */
export const UsageResetRequest = z.object({
  type: z.literal("usage.useReset"),
  instanceId: z.string().min(1).max(256),
  idempotencyKey: z.uuid(),
});
export type UsageResetRequest = z.infer<typeof UsageResetRequest>;

const resetWords: Record<AccountResetOutcome, string> = {
  reset: "Limits reset.",
  alreadyRedeemed: "This reset was already applied.",
  noCredit: "No banked resets remain.",
  nothingToReset: "There are no limits to reset yet.",
};

/** Redeems the reset and answers with what happened, in the web Usage page's words. */
export async function useBankedReset(
  owner: ClientCore,
  request: UsageResetRequest,
  signal: AbortSignal,
): Promise<{ type: "usage.useReset"; outcome: AccountResetOutcome; words: string }> {
  const reply = await owner.request(
    {
      type: "accounts.consumeReset",
      requestId: host.uuid(),
      instanceId: request.instanceId,
      idempotencyKey: request.idempotencyKey,
    },
    { signal, timeoutMs: 30_000 },
  );
  return { type: "usage.useReset", outcome: reply.outcome, words: resetWords[reply.outcome] };
}

export interface UsageLimitPace {
  label: string;
  token: "needsYou" | "neutral";
}

export interface UsageLimitWindow {
  id: string;
  label: string;
  /** What is left, 0 to 100; stale windows carry none. */
  leftPercent: number;
  /** "Resets in 4h 59m", "Reset since this reading", or null when not reported. */
  resets: string | null;
  /** The reset moment in epoch ms, for the phone's own relative dates. */
  resetsAt: number | null;
  /** When the provider last reported the window, in epoch ms. */
  observedAt: number;
  /** Its reset has passed since that reading: what is left now is unknown. */
  stale: boolean;
  /** Its reading is older than a fresh limit (`staleReadingMs`). */
  old: boolean;
  pace: UsageLimitPace | null;
}

export interface UsageLimitAccount {
  key: string;
  /** The account instance, for redeeming a banked reset. */
  instanceId: string;
  /** The machine a banked reset goes through: the one whose reading is shown. */
  machineId: string;
  /** "Studio", or "Mac and Studio" for one login on both; null with a single machine. */
  machine: string | null;
  provider: string;
  label: string;
  /** The plan the provider reports ("Pro"); null when it doesn't say. */
  plan: string | null;
  /** Why its usage can't be read and what to do; null when it reads. */
  signIn: string | null;
  /** Banked resets the provider reports; null when it doesn't report them. */
  bankedResets: number | null;
  bankedExpiresAt: number | null;
  /** The provider has a 5-hour window for some plans but reported none for this account. */
  noSessionWindow: boolean;
  /** Shortest window first, as the account lists them. */
  windows: UsageLimitWindow[];
}

export interface UsageLimitProvider {
  key: string;
  provider: string;
  providerLabel: string;
  accounts: UsageLimitAccount[];
}

export interface UsageLimitReply {
  type: "usage.limits";
  providers: UsageLimitProvider[];
  /** Providers with accounts but no live limits, by name: one quiet line. */
  quiet: string[];
  /** Logins ace can't tell apart across machines, said once each. */
  unsure: string[];
  coverage: UsageCoverageView;
}

/**
 * Reads the machine's accounts; `refresh` first asks its CLIs for current limits. A machine
 * that refuses its accounts reads as a failed service call, like the other native reads.
 */
export async function readUsageAccounts(
  owner: ClientCore,
  refresh: boolean,
  signal: AbortSignal,
): Promise<UsageAccountsReply> {
  const reply = await owner.request(
    { type: refresh ? "accounts.refreshLimits" : "accounts.list", requestId: host.uuid() },
    { signal, timeoutMs: refresh ? 30_000 : 15_000 },
  );
  return { type: "usage.accounts", accounts: reply.accounts };
}

/** Every machine's accounts as the shared limits, shaped for the phone. Pure: no I/O. */
export function combineLimits(request: UsageLimitsCombineRequest, now: number): UsageLimitReply {
  const reaches = request.machines.map((machine) => ({
    ...machine,
    reach: machine.reach === "counted" && !machine.accounts ? ("failed" as const) : machine.reach,
  }));
  const coverage = usageCoverage(reaches);
  const counted = reaches.filter((machine) => machine.reach === "counted");
  const several = request.machines.length > 1;
  const { providers, quiet, unsure } = usageLimits(
    usageAccounts(
      counted.map((machine) => ({
        id: machine.id,
        name: machine.name,
        accounts: (machine.accounts ?? []).map(accountView),
      })),
    ),
    now,
  );
  return {
    type: "usage.limits",
    coverage: { line: coverage.line, complete: coverage.complete },
    providers: providers.map((group) => ({
      key: preview(group.key, 128),
      provider: group.provider,
      providerLabel: preview(group.providerLabel, 64),
      accounts: group.accounts.map((entry) => ({
        key: entry.key,
        instanceId: entry.account.id,
        machineId: entry.environmentId ?? "",
        machine: several ? preview(entry.environment, 256) : null,
        provider: entry.account.provider,
        label: preview(entry.account.label, 128),
        plan: entry.plan ?? null,
        signIn: entry.signIn ? preview(entry.signIn, 512) : null,
        bankedResets: entry.bankedResets ?? null,
        bankedExpiresAt: entry.bankedExpiresAt ?? null,
        noSessionWindow: entry.noSessionWindow,
        windows: entry.windows.map((window) => ({
          id: window.id,
          label: preview(window.label, 128),
          leftPercent: window.leftPercent,
          resets: window.stale ? "Reset since this reading" : countdown(window.resetsAt, now),
          resetsAt: window.resetsAt,
          observedAt: window.observedAt,
          stale: window.stale,
          old: now - window.observedAt > staleReadingMs,
          pace:
            window.pace === "ahead"
              ? { label: "Ahead of pace", token: "needsYou" }
              : window.pace === "behind"
                ? { label: "Under pace", token: "neutral" }
                : null,
        })),
      })),
    })),
    quiet: quiet.map((name) => preview(name, 64)),
    unsure: unsure.map((line) => preview(line, 512)),
  };
}

function countdown(resetsAt: number | null, now: number): string | null {
  const text = resetCountdown(resetsAt, now);
  return text === null ? null : `Resets in ${text}`;
}
