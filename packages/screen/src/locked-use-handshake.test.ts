import { describe, expect, test } from "vitest";
import {
  lockedUseDaemonProof,
  lockedUseProofEquals,
  lockedUseServiceProof,
} from "./locked-use-handshake.ts";

// Vectors verified independently (openssl / python hmac): token 0123456789abcdef x4,
// daemon nonce 11 x32, service nonce 22 x32.
const token = "0123456789abcdef".repeat(4);
const daemonNonce = "11".repeat(32);
const serviceNonce = "22".repeat(32);

describe("locked use handshake proofs", () => {
  test("service and daemon proofs match the known-answer vectors", () => {
    expect(lockedUseServiceProof(token, daemonNonce, serviceNonce)).toBe(
      "5fad966f7fae77a4bac2e07f416011f9e3c02488b38c5e480c7dc5a6f82591af",
    );
    expect(lockedUseDaemonProof(token, daemonNonce, serviceNonce)).toBe(
      "c8b899a76fb02ee15c341927d005dee22ffa31032b1bb4cd697b5285912c4a11",
    );
  });

  test("the two directions and a wrong token all differ", () => {
    const svc = lockedUseServiceProof(token, daemonNonce, serviceNonce);
    const dae = lockedUseDaemonProof(token, daemonNonce, serviceNonce);
    expect(svc).not.toBe(dae);
    expect(lockedUseServiceProof("fe".repeat(32), daemonNonce, serviceNonce)).not.toBe(svc);
    // Swapping the nonces changes the proof, so a captured proof can't be replayed.
    expect(lockedUseServiceProof(token, serviceNonce, daemonNonce)).not.toBe(svc);
  });

  test("proof comparison is exact and rejects malformed input", () => {
    const svc = lockedUseServiceProof(token, daemonNonce, serviceNonce);
    expect(lockedUseProofEquals(svc, svc)).toBe(true);
    expect(lockedUseProofEquals(svc, "0".repeat(64))).toBe(false);
    expect(lockedUseProofEquals(svc, "nothex")).toBe(false);
    expect(lockedUseProofEquals(svc, svc.toUpperCase())).toBe(false);
  });

  test("a nonce that isn't 64 lowercase hex is rejected", () => {
    expect(() => lockedUseServiceProof(token, "11", serviceNonce)).toThrow();
    expect(() => lockedUseServiceProof("short", daemonNonce, serviceNonce)).toThrow();
  });
});
