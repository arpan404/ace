import { z } from "zod";
import { ContainedPath } from "./contained-path.ts";
import {
  MarketEntryName,
  MarketEntryType,
  MarketHash,
  MarketPublisher,
  MarketVersion,
} from "./marketplace-base.ts";

/*
 * What the market's signer vouches for (ADR 0168 §6, ADR 0173 §8): a version's manifest, a
 * review mark, the withdrawn list and the blocklist, each signed with Ed25519 by a market key
 * that never sits on the Worker. Schema only; signing and verifying live in `@ace/marketplace`.
 */

export const MarketKeyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

/** The market's public keys a build ships: two at a time, so one can rotate. */
export const MarketKeySet = z.object({
  keys: z.array(z.object({ id: MarketKeyId, publicKey: PublicKey })).max(2),
});
export type MarketKeySet = z.infer<typeof MarketKeySet>;

export const ManifestFile = z.strictObject({
  path: ContainedPath,
  bytes: z.number().int().nonnegative(),
  executable: z.boolean(),
  sha256: MarketHash,
});
export type ManifestFile = z.infer<typeof ManifestFile>;

export const VersionManifest = z.strictObject({
  format: z.literal("ace-market-manifest"),
  type: MarketEntryType,
  name: MarketEntryName,
  version: MarketVersion,
  publisher: MarketPublisher,
  hash: MarketHash,
  files: z.array(ManifestFile).max(4096),
  size: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  key: MarketKeyId,
});
export type VersionManifest = z.infer<typeof VersionManifest>;

export const ReviewMark = z.strictObject({
  format: z.literal("ace-market-review"),
  type: MarketEntryType,
  name: MarketEntryName,
  hash: MarketHash,
  reviewed: z.boolean(),
  /** Published by ace itself ("By ace"). */
  byAce: z.boolean(),
  at: z.number().int().nonnegative(),
  key: MarketKeyId,
});
export type ReviewMark = z.infer<typeof ReviewMark>;

const reason = z.string().min(1).max(500);
const at = z.number().int().nonnegative();
/**
 * One withdrawal. A publisher withdraws one of their own versions (`version`): it names the
 * entry and version as well as the bytes, and touches nothing else holding the same bytes. Only
 * a maintainer revokes bytes wherever they are (`hash`).
 */
export const Withdrawal = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("version"),
    type: MarketEntryType,
    name: MarketEntryName,
    version: MarketVersion,
    hash: MarketHash,
    reason,
    at,
  }),
  z.strictObject({ scope: z.literal("hash"), hash: MarketHash, reason, at }),
]);
export type Withdrawal = z.infer<typeof Withdrawal>;
export const WithdrawnList = z.strictObject({
  format: z.literal("ace-market-withdrawn"),
  /** When the signer made this list: a device keeps the newest it has verified. */
  issued: z.number().int().nonnegative(),
  withdrawn: z.array(Withdrawal).max(10_000),
  key: MarketKeyId,
});
export type WithdrawnList = z.infer<typeof WithdrawnList>;

/** A literal the known-bad check looks for in every text file, with why it is refused. */
export const MarketBlockedPattern = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  /** Matched case-insensitively after the scanner's unicode folding; at least 6 characters. */
  text: z.string().min(6).max(200),
  reason,
});
export type MarketBlockedPattern = z.infer<typeof MarketBlockedPattern>;

/**
 * The maintainers' known-bad list (ADR 0173 §8): whole versions by content hash, single files by
 * their sha256, and patterns. Signed with the withdrawn list and served at `/v1/blocklist`.
 */
export const MarketBlocklist = z.strictObject({
  format: z.literal("ace-market-blocklist"),
  issued: z.number().int().nonnegative(),
  hashes: z.array(z.strictObject({ hash: MarketHash, reason })).max(10_000),
  files: z.array(z.strictObject({ sha256: MarketHash, reason })).max(10_000),
  patterns: z.array(MarketBlockedPattern).max(1_000),
  key: MarketKeyId,
});
export type MarketBlocklist = z.infer<typeof MarketBlocklist>;

/** A statement with its signature, as the Worker serves and stores it. */
export const Signed = z.strictObject({ body: z.unknown(), signature: Signature });
export type Signed = z.infer<typeof Signed>;
