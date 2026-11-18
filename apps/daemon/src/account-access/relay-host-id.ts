import { join } from "node:path";
import { hostId, type KeyPair } from "@ace/secure-channel";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";

/**
 * This machine's relay host key: the key its Noise handshake proves on ace's relay, whose host id
 * its machine grants name and its machine credential is bound to (ADR 0111, ADR 0190).
 */
export function relayKeysFor(dataDir: string): Promise<KeyPair> {
  return loadOrCreateHostKeys(join(dataDir, "relay"));
}

/** The host id `relayKeysFor` names. */
export async function relayHostIdFor(dataDir: string): Promise<string> {
  return hostId((await relayKeysFor(dataDir)).publicKey);
}
