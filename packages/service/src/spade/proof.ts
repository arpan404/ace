import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Spade proves it holds its token before anyone sends it (ADR 0123): `GET /health?nonce=<hex>`
 * answers `proof`, the lowercase hex HMAC-SHA256 of the nonce keyed with the token file's
 * contents. A stale `server.json` naming a port another local process now holds can't answer,
 * so that process never sees the token.
 */

/** A nonce Spade takes: lowercase hex, 16 to 64 characters. */
export const isSpadeNonce = (nonce: string): boolean => /^[0-9a-f]{16,64}$/.test(nonce);

/** A fresh nonce for one check: 16 random bytes. */
export function newSpadeNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The proof Spade gives for `nonce` when it holds `token`. */
export function spadeProof(token: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(token, "utf8"))
    .update(Buffer.from(nonce, "utf8"))
    .digest("hex");
}

/** Whether `proof` (from Spade's answer, any shape) is the right one, compared in constant time. */
export function checkSpadeProof(token: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, "utf8"), Buffer.from(spadeProof(token, nonce), "utf8"));
}
