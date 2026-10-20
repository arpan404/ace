import { fingerprint, type KeyPair } from "@ace/secure-channel";
import type { RemoteAccessStatus } from "@ace/protocol";

/**
 * How a paired client reaches this daemon's channels through its relay: the relay's address,
 * the host key a client pins, and the daemon identity its welcome names. None of it is secret
 * (the key is public); it is shown to administrators only, with the rest of remote status.
 */
export function relayRoute(
  relay: { url: string; keys: KeyPair } | undefined,
  hostId: string,
): Pick<RemoteAccessStatus, "relay"> {
  return relay
    ? { relay: { url: relay.url, fingerprint: fingerprint(relay.keys.publicKey), hostId } }
    : {};
}
