import { NativeAccountProvider } from "@ace/protocol/accounts";
import type { AccountSummary as Summary } from "@ace/protocol/accounts";
import type { z } from "zod";
import { blockedUntil } from "@ace/accounts/availability";

type AccountSummary = z.infer<typeof Summary>;
import { accountList, type FakeAccount } from "../catalog/accounts.ts";

/** The catalog's window ids as the providers report them (Claude's unified windows). */
const windowNames: Record<string, string> = {
  "five-hour": "five_hour",
  weekly: "seven_day",
  daily: "daily",
};

/** One catalog account as `accounts.list` reports it: quota and availability, no credentials. */
export function accountSummary(account: FakeAccount, now: number): AccountSummary {
  return {
    id: account.id,
    provider: account.provider,
    ...(account.provider === "acp"
      ? { acpAgentId: "Gemini CLI", installationId: "installed", instanceId: account.id }
      : {}),
    installationVersion: account.cliVersion,
    label: account.label,
    authMethod: "browser",
    availability: account.availability,
    quota: {
      auth: account.availability === "logged_out" ? "logged_out" : "logged_in",
      observedAt: now,
      billingMode:
        account.provider === "codex" || account.provider === "claude" ? "subscription" : "unknown",
      ...(account.provider === "codex"
        ? { plan: "pro" }
        : account.provider === "claude"
          ? { plan: "max" }
          : {}),
      windows: Object.fromEntries(
        account.windows.map((window) => [
          windowNames[window.id] ?? window.id,
          {
            usedPercent: window.usedPercent,
            remainingPercent: 100 - window.usedPercent,
            resetsAt: window.resetsAt,
            source: "cli" as const,
            ...(window.id === "five-hour"
              ? { windowDurationMins: 300 }
              : window.id === "weekly"
                ? { windowDurationMins: 10080 }
                : {}),
          },
        ]),
      ),
      blockers: {},
      usage: {},
    },
  };
}

/** A CLI signed in with its default home and no quota windows to report. */
function plain(id: "opencode" | "cursor", version: string, now: number): AccountSummary {
  return {
    id,
    provider: id,
    installationVersion: version,
    label: id === "cursor" ? "Default (your SDK login)" : "Default (your CLI login)",
    authMethod: "unknown",
    implicit: true,
    isDefault: true,
    availability: "unknown",
    quota: { auth: "unknown", observedAt: now, windows: {}, blockers: {}, usage: {} },
  };
}

/** The accounts in the approved design, as the daemon lists them. */
export function accountSummaries(now: number): AccountSummary[] {
  const registered = accountList(now);
  const accounts: AccountSummary[] = [
    ...registered.map((account) => accountSummary(account, now)),
    ...(["opencode", "cursor", "pi"] as const).flatMap((provider) =>
      [1, 2].map((number): AccountSummary => ({
        id: `${provider}-extra-${number}`,
        provider,
        label: number === 1 ? "Work" : "Personal",
        authMethod: number === 1 ? "api_key" : "browser",
        implicit: false,
        isDefault: false,
        availability: provider === "cursor" ? "logged_out" : "available",
        quota: {
          auth: provider === "cursor" ? "logged_out" : "logged_in",
          observedAt: now,
          windows: {},
          blockers: {},
          usage: {},
        },
      })),
    ),
    ...NativeAccountProvider.options
      .filter((provider) => provider !== "opencode" && provider !== "cursor")
      .map((provider) => ({
        id: `${provider}-cli-default`,
        provider,
        installationVersion: registered.find((account) => account.provider === provider)
          ?.cliVersion,
        label: "Default (your CLI login)",
        implicit: true,
        isDefault: true,
        availability: "unknown" as const,
        quota: {
          auth: "unknown" as const,
          observedAt: now,
          windows: {},
          blockers: {},
          usage: {},
        },
      })),
    plain("opencode", "1.4", now),
    plain("cursor", "1.0.35", now),
    {
      ...plain("opencode", "1.4", now),
      id: "opencode-api",
      implicit: false,
      isDefault: false,
      label: "OpenRouter API",
      quota: {
        auth: "logged_in",
        observedAt: now,
        billingMode: "api",
        windows: {},
        blockers: {},
        usage: {},
      },
    },
    {
      id: "pi-api",
      provider: "pi",
      label: "API key",
      availability: "available",
      quota: {
        auth: "logged_in",
        observedAt: now,
        billingMode: "api",
        windows: {},
        blockers: {},
        usage: {},
      },
    },
  ];
  return accounts.map((account) =>
    Object.assign(account, { blockedUntil: blockedUntil(account.quota, now) }),
  );
}
