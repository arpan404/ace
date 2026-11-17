import type { MachineAccountStatus } from "@ace/protocol";
import type { AccountSummary, ProviderInstance } from "@ace/protocol/accounts";
import { columns } from "./provider-columns.ts";

/** `ace account …` and `ace provider account …` for a person. Pure. */

export function aceAccountLines(status: MachineAccountStatus): string[] {
  const who = status.account?.email;
  const lines = [
    status.signedIn
      ? who
        ? `Signed in to ace as ${who}.`
        : "Signed in to ace."
      : status.login
        ? "Signing in to ace: finish in the browser."
        : "Not signed in to ace. Sign in with ace login.",
  ];
  if (status.login) lines.push(status.login.url);
  if (status.signedIn)
    lines.push(
      status.machineCode.set
        ? "Machine code set: devices on your account enter it once."
        : "No machine code. Set one with ace account machine-code set.",
    );
  return lines;
}

const availability: Readonly<Record<string, string>> = {
  available: "ready",
  near_limit: "near its limit",
  exhausted: "out of usage",
  logged_out: "signed out",
  unknown: "checking",
};

export function providerAccountLines(accounts: readonly AccountSummary[]): string[] {
  if (!accounts.length)
    return ["No provider accounts yet. Find them with ace provider account discover."];
  return columns(
    accounts.map((account) => [
      account.id,
      account.provider,
      account.label,
      availability[account.availability] ?? account.availability,
      account.signedInAs,
      account.isDefault ? "default" : undefined,
    ]),
  );
}

export function providerAccountShowLines(account: AccountSummary): string[] {
  return [
    `${account.label} (${account.id})`,
    ...columns(
      (
        [
          ["  provider", account.provider],
          ["  state", availability[account.availability] ?? account.availability],
          ["  signed in as", account.signedInAs],
          ["  plan", account.quota.plan],
          ["  home", account.cliHome],
        ] as const
      ).filter((row) => row[1]),
    ),
  ];
}

export function discoveredLines(found: readonly ProviderInstance[]): string[] {
  if (!found.length) return ["No provider homes found on this machine."];
  return [
    ...columns(found.map((instance) => [instance.id, instance.provider, instance.label])),
    "",
    "Add one with ace provider account add PROVIDER ID HOME LABEL.",
  ];
}
