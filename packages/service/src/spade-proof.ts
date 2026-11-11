import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Spade proves it holds its token (ADR 0123, #1799): `GET /health?nonce=<hex>` answers `proof`,
 * the lowercase hex HMAC-SHA256 of the nonce keyed with the token file's contents. The updater
 * checks it before trusting that the Spade at `server.json`'s address is the new one. The same
 * helpers arrive in `@ace/service/spade` with the desktop's direct path (#1796); this module
 * gives way to them once that merges.
 */

/** A fresh nonce for one check: 16 random bytes as hex. */
export function newSpadeNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The proof Spade gives for `nonce` when it holds `token`. */
export function spadeProof(token: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(token, "utf8"))
    .update(Buffer.from(nonce, "utf8"))
    .digest("hex");
}

/** Whether `proof` (any shape, from Spade's answer) is right, compared in constant time. */
export function checkSpadeProof(token: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof), Buffer.from(spadeProof(token, nonce)));
}
