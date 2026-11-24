import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, it } from "vitest";
import { readReviewChallenge, reviewChallenge, verifiesSpadeReview } from "./review-challenge.ts";

const target = {
  type: "spade-skill",
  draft: "drf_markit",
  publisher: "pub_example",
  name: "markit",
  version: "2.0.0",
  hash: "a".repeat(64),
  visibility: "unlisted",
};
const items = "b".repeat(64);
const seed = new Uint8Array(32).fill(9);
const key = bytesToHex(ed25519.getPublicKey(seed));

it("accepts only the canonical review message at the signer boundary", () => {
  const message = reviewChallenge(target, items) ?? "";
  expect(readReviewChallenge(message)).toEqual([
    "ace-spade-market-review/1",
    "spade-skill",
    "pub_example",
    "markit",
    "2.0.0",
    target.hash,
    "unlisted",
    "drf_markit",
    items,
  ]);
  expect(readReviewChallenge(` ${message}`)).toBeUndefined();
  expect(readReviewChallenge(JSON.stringify(["sign arbitrary data", message]))).toBeUndefined();
  expect(reviewChallenge({ ...target, visibility: "public" }, items)).toBeUndefined();
});

it("requires a trusted signature over the exact package, checklist and destination", () => {
  const message = new TextEncoder().encode(reviewChallenge(target, items));
  const signature = bytesToHex(ed25519.sign(message, seed));
  const proof = `${items}.${signature}`;
  expect(verifiesSpadeReview(target, proof, [key])).toBe(true);
  expect(verifiesSpadeReview(target, items, [key])).toBe(false);
  expect(verifiesSpadeReview(target, proof, [])).toBe(false);
  expect(verifiesSpadeReview(target, `${proof}.extra`, [key])).toBe(false);
  expect(verifiesSpadeReview(target, `${"c".repeat(64)}.${signature}`, [key])).toBe(false);
  expect(verifiesSpadeReview({ ...target, hash: "c".repeat(64) }, proof, [key])).toBe(false);
  expect(verifiesSpadeReview({ ...target, visibility: "listed" }, proof, [key])).toBe(false);
  expect(verifiesSpadeReview({ ...target, draft: "drf_new" }, proof, [key])).toBe(false);
});
