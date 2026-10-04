import { NativeAccountProvider } from "@ace/protocol/accounts";
import type { AccountSummary as Summary } from "@ace/protocol/accounts";
import type { z } from "zod";

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
    availability: account.availability,
    quota: {
      auth: account.availability === "logged_out" ? "logged_out" : "logged_in",
      observedAt: now,
      windows: Object.fromEntries(
        account.windows.map((window) => [
          windowNames[window.id] ?? window.id,
          { usedPercent: window.usedPercent, resetsAt: window.resetsAt },
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
    label: "Default (your CLI login)",
    implicit: true,
    isDefault: true,
    availability: "available",
    quota: { auth: "logged_in", observedAt: now, windows: {}, blockers: {}, usage: {} },
  };
}

/** The accounts in the approved design, as the daemon lists them. */
export function accountSummaries(now: number): AccountSummary[] {
  return [
    ...accountList(now).map((account) => accountSummary(account, now)),
    ...NativeAccountProvider.options
      .filter((provider) => provider !== "opencode" && provider !== "cursor")
      .map((provider) => ({
        id: `${provider}-cli-default`,
        provider,
        label: "Default (your CLI login)",
        implicit: true,
        isDefault: true,
        availability: "available" as const,
        quota: {
          auth: "logged_in" as const,
          observedAt: now,
          windows: {},
          blockers: {},
          usage: {},
        },
      })),
    plain("opencode", "1.4", now),
    plain("cursor", "0.9", now),
  ];
}
