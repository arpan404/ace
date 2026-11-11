import { expect, test } from "vitest";
import { checkSpadeProof, isSpadeNonce, newSpadeNonce, spadeProof } from "./proof.ts";

// RFC 4231, test case 2: HMAC-SHA256 with key "Jefe".
const rfcProof = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

test("the proof is HMAC-SHA256 of the nonce keyed with the token, in lowercase hex", () => {
  expect(spadeProof("Jefe", "what do ya want for nothing?")).toBe(rfcProof);
  expect(checkSpadeProof("Jefe", "what do ya want for nothing?", rfcProof)).toBe(true);
});

test.each([
  ["another token's proof", spadeProof("other", "00112233445566778899")],
  ["the proof in capitals", spadeProof("token", "00112233445566778899").toUpperCase()],
  ["a truncated proof", spadeProof("token", "00112233445566778899").slice(0, 32)],
  ["no proof", undefined],
  ["a number", 42],
])("%s doesn't count", (_name, proof) => {
  expect(checkSpadeProof("token", "00112233445566778899", proof)).toBe(false);
});

test("each check asks with a fresh nonce Spade takes", () => {
  const nonce = newSpadeNonce();
  expect(isSpadeNonce(nonce)).toBe(true);
  expect(newSpadeNonce()).not.toBe(nonce);
  expect(isSpadeNonce("abc")).toBe(false);
  expect(isSpadeNonce("ABCDEF0123456789")).toBe(false);
});
