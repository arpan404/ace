import type { MachineAccountStatus } from "@ace/protocol";
import type { AceAccount } from "@ace/protocol/ace-account";

/** What the "ace account" row offers for this machine. */
export type MachineAccountAction =
  /** Sign the machine in with this app's session. */
  | "signIn"
  | "signOut"
  /** The machine is on another account than this app: move it to this app's. */
  | "switch"
  /** The machine is signed out and so is this app: sign in under Profile first. */
  | "appFirst"
  | "none";

/**
 * The organization an org host's own sign-in speaks for (ADR 0206 §2.1), by name: its account is
 * the organization's principal (`org:<id>`), whose email is only a placeholder. Undefined for a
 * person's account.
 */
export function orgAccountName(account: Pick<AceAccount, "id" | "name">): string | undefined {
  if (!account.id.startsWith("org:")) return undefined;
  return account.name.trim() || "its organization";
}

/**
 * The sentence under "ace account" for this computer's daemon, and its action, from the
 * daemon's own account status and the account this app is signed in to (if any).
 */
export function machineAccountRow(
  status: MachineAccountStatus,
  app: AceAccount | undefined,
): { sentence: string; action: MachineAccountAction } {
  if (status.signedIn && status.account) {
    // An org host signs in as its organization, never as a person: nothing to sign out here.
    const org = orgAccountName(status.account);
    if (org)
      return {
        sentence: `Signed in as ${org}, the organization that holds it. Its members open it with their own sign-in.`,
        action: "none",
      };
    if (app && app.id !== status.account.id)
      return {
        sentence: `Signed in as ${status.account.email}, not ${app.email} like this app.`,
        action: "switch",
      };
    return {
      sentence: `Signed in as ${status.account.email}. Your devices on this account can open it.`,
      action: "signOut",
    };
  }
  if (status.login)
    return { sentence: "Finishing sign-in in a browser.", action: app ? "signIn" : "none" };
  return app
    ? {
        sentence: "Not signed in. Sign it in to open it from your other devices.",
        action: "signIn",
      }
    : {
        sentence: "Not signed in. Sign in to your ace account under Profile first.",
        action: "appFirst",
      };
}

/** The one sentence the machine code setting explains itself with (ADR 0111). */
export const machineCodeSentence =
  "Keeps this machine closed to a stolen account login; every device enters the code again after it changes.";
