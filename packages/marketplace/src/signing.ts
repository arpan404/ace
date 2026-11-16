import { ed25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";
import {
  MarketEntryName,
  MarketEntryType,
  MarketHash,
  MarketPublisher,
  MarketVersion,
} from "@ace/protocol/marketplace";
import { ContainedPath } from "@ace/protocol";
import { decodeBase64url, encodeBase64url } from "@ace/account-grant";
import { contentHash, type HashedFile } from "./hash.ts";

/*
 * What the signer vouches for (ADR 0168 §6): a version's manifest, a review mark and the list of
 * withdrawn versions, each signed with Ed25519 by a market key that never sits on the Worker.
 * Every statement is signed over its canonical JSON behind a label naming its kind, so a
 * signature on one kind never verifies as another.
 */

const KeyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

/** The market's public keys a build ships: two at a time, so one can rotate. */
export const MarketKeySet = z.object({
  keys: z.array(z.object({ id: KeyId, publicKey: PublicKey })).max(2),
});
export type MarketKeySet = z.infer<typeof MarketKeySet>;
export interface MarketSigningKey {
  id: string;
  privateKey: Uint8Array;
}

export class SignatureError extends Error {
  override name = "SignatureError";
}

export const ManifestFile = z.strictObject({
  path: ContainedPath,
  bytes: z.number().int().nonnegative(),
  executable: z.boolean(),
  sha256: MarketHash,
});

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
  key: KeyId,
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
  key: KeyId,
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
  key: KeyId,
});
export type WithdrawnList = z.infer<typeof WithdrawnList>;

/** A statement with its signature, as the Worker serves and stores it. */
export const Signed = z.strictObject({ body: z.unknown(), signature: Signature });
export type Signed = z.infer<typeof Signed>;

const labels = {
  manifest: "ace-market-manifest-v1",
  review: "ace-market-review-v1",
  withdrawn: "ace-market-withdrawn-v1",
} as const;
type Kind = keyof typeof labels;

/** JSON with object keys sorted at every depth and no spaces: one text per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new SignatureError("Only finite numbers can be signed");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

const encoder = new TextEncoder();
const message = (kind: Kind, body: unknown) =>
  encoder.encode(`${labels[kind]}\n${canonicalJson(body)}`);

function sign(kind: Kind, body: { key: string }, key: MarketSigningKey): Signed {
  if (body.key !== key.id) throw new SignatureError("The statement names another key");
  return { body, signature: encodeBase64url(ed25519.sign(message(kind, body), key.privateKey)) };
}

function verify<T extends { key: string }>(
  kind: Kind,
  signed: unknown,
  schema: z.ZodType<T>,
  keys: MarketKeySet,
): T {
  const envelope = Signed.safeParse(signed);
  if (!envelope.success) throw new SignatureError("The signed statement is malformed");
  const body = schema.safeParse(envelope.data.body);
  if (!body.success) throw new SignatureError("The signed statement is malformed");
  const key = keys.keys.find((candidate) => candidate.id === body.data.key);
  if (!key) throw new SignatureError(`Signed by a key this build doesn't know (${body.data.key})`);
  let valid = false;
  try {
    valid = ed25519.verify(
      decodeBase64url(envelope.data.signature),
      message(kind, body.data),
      decodeBase64url(key.publicKey),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new SignatureError("The signature doesn't match");
  return body.data;
}

export const signManifest = (body: VersionManifest, key: MarketSigningKey) =>
  sign("manifest", VersionManifest.parse(body), key);
export const signReviewMark = (body: ReviewMark, key: MarketSigningKey) =>
  sign("review", ReviewMark.parse(body), key);
export const signWithdrawn = (body: WithdrawnList, key: MarketSigningKey) =>
  sign("withdrawn", WithdrawnList.parse(body), key);

export const verifyManifest = (signed: unknown, keys: MarketKeySet) =>
  verify("manifest", signed, VersionManifest, keys);
export const verifyReviewMark = (signed: unknown, keys: MarketKeySet) =>
  verify("review", signed, ReviewMark, keys);
export const verifyWithdrawn = (signed: unknown, keys: MarketKeySet) =>
  verify("withdrawn", signed, WithdrawnList, keys);

/** The public half of a signing key, as a build ships it. */
export function marketPublicKey(key: MarketSigningKey): MarketKeySet["keys"][number] {
  return {
    id: KeyId.parse(key.id),
    publicKey: encodeBase64url(ed25519.getPublicKey(key.privateKey)),
  };
}

/** A fresh signing key from 32 random bytes the caller supplies. */
export function marketSigningKey(id: string, seed: Uint8Array): MarketSigningKey {
  if (seed.byteLength !== 32) throw new SignatureError("A signing key is 32 bytes");
  return { id: KeyId.parse(id), privateKey: seed };
}

/**
 * Whether `files` (hashed from the archive the device fetched) are exactly what `manifest`
 * lists, and hash to its content hash. Returns the first mismatch, or undefined.
 */
export function manifestMismatch(
  manifest: VersionManifest,
  files: readonly HashedFile[],
): string | undefined {
  if (contentHash(files) !== manifest.hash) return "The archive's content hash doesn't match";
  if (files.length !== manifest.files.length) return "The archive holds other files than signed";
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of files) {
    const signed = listed.get(file.path);
    if (!signed) return `${file.path} isn't in the signed manifest`;
    if (
      signed.bytes !== file.bytes ||
      signed.sha256 !== file.sha256 ||
      signed.executable !== file.executable
    )
      return `${file.path} doesn't match the signed manifest`;
  }
  const size = files.reduce((sum, file) => sum + file.bytes, 0);
  if (size !== manifest.size) return "The archive's size doesn't match";
  return undefined;
}

/** A version of an entry with its bytes, as a withdrawal may name it. */
export interface WithdrawalTarget {
  type: string;
  name: string;
  version: string;
  hash: string;
}

/**
 * Why `target` is withdrawn, if it is: a maintainer revoked its bytes, or its publisher
 * withdrew this very version. Another entry holding the same bytes is untouched by the latter.
 */
export function withdrawalReason(
  withdrawn: readonly Withdrawal[],
  target: WithdrawalTarget,
): string | undefined {
  return withdrawn.find(
    (entry) =>
      entry.hash === target.hash &&
      (entry.scope === "hash" ||
        (entry.type === target.type &&
          entry.name === target.name &&
          entry.version === target.version)),
  )?.reason;
}

/** The identity of a withdrawal, so a list never holds the same one twice. */
export const withdrawalKey = (entry: Withdrawal) =>
  entry.scope === "hash"
    ? `hash:${entry.hash}`
    : `version:${entry.type}/${entry.name}@${entry.version}:${entry.hash}`;
