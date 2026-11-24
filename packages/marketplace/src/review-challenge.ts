import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Proof = z.string().regex(/^[0-9a-f]{128}$/);
const Field = z.string().min(1).max(256);
const Challenge = z.tuple([
  z.literal("ace-spade-market-review/1"),
  z.enum(["spade-bot", "spade-skill"]),
  Field,
  Field,
  Field,
  Digest,
  z.enum(["listed", "unlisted"]),
  Field,
  Digest,
]);

export interface ReviewTarget {
  type: string;
  publisher: string;
  name: string;
  version: string;
  hash: string;
  visibility: string;
  draft: string;
}

/** The message shared by Spade, the presence signer and the Store. */
export function reviewChallenge(target: ReviewTarget, items: string): string | undefined {
  const parsed = Challenge.safeParse([
    "ace-spade-market-review/1",
    target.type,
    target.publisher,
    target.name,
    target.version,
    target.hash,
    target.visibility,
    target.draft,
    items,
  ]);
  return parsed.success ? JSON.stringify(parsed.data) : undefined;
}

/** An OS signer accepts only this canonical message, never arbitrary bytes. */
export function readReviewChallenge(text: string) {
  if (text.length > 4096) return undefined;
  try {
    const parsed = Challenge.safeParse(JSON.parse(text));
    return parsed.success && JSON.stringify(parsed.data) === text ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function verifiesSpadeReview(
  target: ReviewTarget,
  proof: string,
  pinned: readonly string[],
): boolean {
  const [items, signature, extra] = proof.split(".");
  if (
    items === undefined ||
    signature === undefined ||
    extra !== undefined ||
    !Proof.safeParse(signature).success
  )
    return false;
  const message = reviewChallenge(target, items);
  if (!message) return false;
  const bytes = new TextEncoder().encode(message);
  const signed = hexToBytes(signature);
  return pinned.some((key) => {
    try {
      return Digest.safeParse(key).success && ed25519.verify(signed, bytes, hexToBytes(key));
    } catch {
      return false;
    }
  });
}
