import { join } from "node:path";
import { hostId } from "@ace/secure-channel";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";

/**
 * This machine's host id on ace's relay: the id its relay key proves in the Noise handshake, the
 * one its machine grants name and its machine credential is bound to (ADR 0111, ADR 0189).
 */
export async function relayHostIdFor(dataDir: string): Promise<string> {
  return hostId((await loadOrCreateHostKeys(join(dataDir, "relay"))).publicKey);
}
