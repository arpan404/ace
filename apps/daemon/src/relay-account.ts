import { SettingsError } from "@ace/settings";
import { hostId, type KeyPair } from "@ace/secure-channel";
import type { MachineAccount } from "./account-access/machine-account.ts";

/** ace's hosted relay, which admits only machines signed in to an ace account (ADR 0111). */
export function isHostedRelay(relayUrl: string, hostedRelayUrl: string | undefined): boolean {
  if (!relayUrl || !hostedRelayUrl) return false;
  try {
    return new URL(relayUrl).origin === new URL(hostedRelayUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Remote access cannot use ace's relay until the person acts (signs in, or signs in again). It
 * is shown as the remote access error and is not retried; an account change applies it again.
 */
export class RelayNeedsAccount extends SettingsError {
  constructor(message: string) {
    super("validation", message);
  }
}

export const signInForRelay = "Sign in to your ace account on this machine to use ace's relay.";
export const relayRefusedMachine =
  "ace's relay refused this machine. Sign in to your ace account on this machine again.";

/** What the relay connection needs from the account: a fresh machine grant per attempt. */
export function hostedRelayAccess(
  account: MachineAccount | undefined,
  keys: KeyPair,
): { grant: () => Promise<string>; accountId: string } {
  const signedIn = account?.account();
  if (!account || !signedIn) throw new RelayNeedsAccount(signInForRelay);
  const id = hostId(keys.publicKey);
  return { grant: () => account.machineGrant(id), accountId: signedIn.id };
}
