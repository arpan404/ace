import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * The daemon and `ace-screen-helper --locked-use` prove to each other that they share the
 * 32-byte token the daemon handed the service on its stdin, without ever sending the token over
 * the socket. Each side sends a fresh 32-byte nonce; the proof is an HMAC-SHA256 over a labelled
 * message of both nonces, keyed by the token. Different labels and nonce orders keep the two
 * directions distinct, so neither proof can be replayed as the other.
 */

const serviceLabel = "ace-locked-use service proof";
const daemonLabel = "ace-locked-use daemon proof";

function hexBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Expected 64 lowercase hex characters");
  return Buffer.from(hex, "hex");
}

function proof(label: string, tokenHex: string, first: string, second: string): string {
  const mac = createHmac("sha256", hexBytes(tokenHex));
  mac.update(
    Buffer.concat([
      Buffer.from(label, "utf8"),
      Buffer.from([0]),
      hexBytes(first),
      hexBytes(second),
    ]),
  );
  return mac.digest("hex");
}

/** What the service must return: keyed by the token, over daemonNonce then serviceNonce. */
export function lockedUseServiceProof(
  tokenHex: string,
  daemonNonceHex: string,
  serviceNonceHex: string,
): string {
  return proof(serviceLabel, tokenHex, daemonNonceHex, serviceNonceHex);
}

/** What the daemon returns to the service: over serviceNonce then daemonNonce. */
export function lockedUseDaemonProof(
  tokenHex: string,
  daemonNonceHex: string,
  serviceNonceHex: string,
): string {
  return proof(daemonLabel, tokenHex, serviceNonceHex, daemonNonceHex);
}

/** Constant-time equality of two 64-hex proofs; false on any malformed input. */
export function lockedUseProofEquals(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
