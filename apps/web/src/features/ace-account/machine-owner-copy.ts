import type { MachineAccountStatus } from "@ace/protocol";
import type { AceAccount } from "@ace/protocol/ace-account";

/** What the owner row offers: letting the machine go, or how to fix an owner that isn't you. */
export type MachineOwnerAction = "release" | "notYou" | "none";

/**
 * Who a machine belongs to (ADR 0190 §3a), told so the person can see it and fix it: the account
 * whose person's grants act as the person there, which needn't be the one it is signed in to.
 * `app`: the account this window is signed in to. Undefined from a daemon that doesn't say.
 */
export function machineOwnerRow(
  status: MachineAccountStatus,
  app: AceAccount | undefined,
): { sentence: string; action: MachineOwnerAction } | undefined {
  if (status.owner === undefined) return undefined;
  if (status.owner === null)
    return {
      sentence:
        "No account owns this machine yet. It becomes yours the first time the ace app, signed in as you, connects.",
      action: "none",
    };
  // An organization's host (ADR 0206 §2.1): its owners release it, from a connection where they
  // proved they're one.
  if ("org" in status.owner)
    return {
      sentence: "This machine is an organization's host: its owners can release it.",
      action: "none",
    };
  const { account } = status.owner;
  if (app?.id === account)
    return { sentence: `This machine belongs to you (${app.email}).`, action: "release" };
  const name = status.account?.id === account ? status.account.email : "another ace account";
  return { sentence: `This machine belongs to ${name}.`, action: "notYou" };
}

/** How a person who isn't the owner takes the machine back. */
export const notYouSteps =
  "Only that account can let it go, from its own ace app. Or reset it on this computer: quit ace, delete ace-owner.json in ace's data folder, then start ace again. Devices you paired then need pairing again to act as you.";
