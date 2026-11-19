import type { AceMachine } from "@ace/protocol/ace-account";
import { formatAgo } from "@ace/ui-core";

/** A machine on the person's ace account that this window doesn't reach through pairing. */
export interface AccountMachine {
  hostId: string;
  name: string;
  platform: string;
  lastSeenAt: number;
}

export interface AccountMachineLists {
  /** On the account and not already listed: shown after the paired machines. */
  only: readonly AccountMachine[];
  /** Host ids of listed machines that are on the account too. */
  alsoOnAccount: ReadonlySet<string>;
}

/**
 * Joins the account's machines to the ones this window already lists (its own daemon and the
 * paired ones), by host id, so a machine that is both appears once, as the listed one.
 */
export function accountMachineLists(
  listed: readonly { id: string }[],
  account: readonly AceMachine[],
): AccountMachineLists {
  const ids = new Set(listed.map((machine) => machine.id));
  const alsoOnAccount = new Set<string>();
  const only: AccountMachine[] = [];
  const seen = new Set<string>();
  for (const machine of account) {
    if (seen.has(machine.hostId)) continue;
    seen.add(machine.hostId);
    if (ids.has(machine.hostId)) alsoOnAccount.add(machine.hostId);
    else only.push({ ...machine, name: machine.name.trim() || "Unnamed machine" });
  }
  return { only, alsoOnAccount };
}

const platforms: Record<string, string> = {
  darwin: "macOS",
  macos: "macOS",
  linux: "Linux",
  win32: "Windows",
  windows: "Windows",
  freebsd: "FreeBSD",
};

/** "macOS", "Windows": the platform as a person names it, else what the machine reported. */
export function platformName(platform: string): string {
  return platforms[platform.toLowerCase()] ?? platform;
}

/** "macOS · Seen 2h ago": what an account machine's row says under its name. */
export function accountMachineLine(machine: AccountMachine, now: number): string {
  return [
    machine.platform && platformName(machine.platform),
    machine.lastSeenAt > 0 ? `Seen ${formatAgo(machine.lastSeenAt, now)}` : "Not seen yet",
  ]
    .filter(Boolean)
    .join(" · ");
}
