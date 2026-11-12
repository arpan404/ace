import { SettingsError } from "@ace/settings";
import { hostId, type KeyPair } from "@ace/secure-channel";
import { HostedAddress } from "@ace/protocol/ace-account";
import type { MachineAccount } from "./account-access/machine-account.ts";

const hostedOrigin = (url: string) => new URL(HostedAddress.parse(url)).origin;

/**
 * ace's hosted relay, which admits only machines signed in to an ace account (ADR 0111). An
 * address on a former host of ace's backend is the same relay.
 */
export function isHostedRelay(relayUrl: string, hostedRelayUrl: string | undefined): boolean {
  if (!relayUrl || !hostedRelayUrl) return false;
  try {
    return hostedOrigin(relayUrl) === hostedOrigin(hostedRelayUrl);
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

/**
 * What the relay connection needs from the account: a fresh machine grant per attempt, and the
 * name and platform that label this machine in the account's machine list.
 */
export function hostedRelayAccess(
  account: MachineAccount | undefined,
  keys: KeyPair,
  label: { name?: string | undefined; platform: string },
): {
  account: { grant(signal: AbortSignal): Promise<string>; name?: string; platform: string };
  accountId: string;
} {
  const signedIn = account?.account();
  if (!account || !signedIn) throw new RelayNeedsAccount(signInForRelay);
  const id = hostId(keys.publicKey);
  return {
    account: {
      grant: (signal) => account.machineGrant(id, signal),
      ...(label.name ? { name: label.name.slice(0, 256) } : {}),
      platform: label.platform,
    },
    accountId: signedIn.id,
  };
}
