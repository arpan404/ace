import { z } from "zod";
import {
  MarketEntryName,
  MarketEntryType,
  MarketHash,
  MarketPublisher,
  MarketVersion,
} from "./marketplace-base.ts";
import { MarketHandle, MarketVersionStatus } from "./marketplace-publisher.ts";
import { MarketScanVerdict } from "./marketplace-scan.ts";
import {
  MarketKeyId,
  MarketOrgId,
  MarketPublicKey,
  MarketSignature,
} from "./marketplace-signed.ts";

/*
 * An organization's private registry on the market (ADR 0206 §5): its publisher, the key chain
 * devices pin, and what its signer reads. Schema only; signing and verifying the chain live in
 * `@ace/marketplace/registry`.
 */

/**
 * One key of a registry's chain, as an owner states it. The first (`position` 0) has no
 * `previous`; each later key names the one before it, which signs the statement.
 */
export const RegistryKeyStatement = z.strictObject({
  format: z.literal("ace-registry-key"),
  org: MarketOrgId,
  position: z.number().int().min(0).max(63),
  key: MarketKeyId,
  publicKey: MarketPublicKey,
  previous: MarketKeyId.optional(),
  /** The owner's account that published it. */
  addedBy: z.string().min(1).max(128),
  at: z.number().int().nonnegative(),
});
export type RegistryKeyStatement = z.infer<typeof RegistryKeyStatement>;

/** `POST /v1/orgs/{org}/keys`: a key statement, proved by the new key and, after the first, the key before it. */
export const RegistryKeyUpload = z.strictObject({
  statement: RegistryKeyStatement,
  /** The new key's signature over the statement: whoever sent it holds the private half. */
  proof: MarketSignature,
  /** For a later key: the previous key's signature over the statement. */
  rotation: MarketSignature.optional(),
});
export type RegistryKeyUpload = z.infer<typeof RegistryKeyUpload>;

/**
 * One link as the market serves it, and as an owner sends it (`POST /v1/orgs/{org}/keys`): the
 * upload's exact text, and the account backend's attestation of that text (ADR 0206 §5.3), made
 * for an owner of the organization from the person's own session. The attestation authorizes
 * nothing, so serving it hands out no credential.
 */
export const RegistryKeyLink = z.strictObject({
  upload: z.string().min(1).max(4096),
  attestation: z.string().min(1).max(4096),
});
export type RegistryKeyLink = z.infer<typeof RegistryKeyLink>;

/** `GET /v1/orgs/{org}/keys`: the registry's chain, first key first. Members only. */
export const RegistryKeyChain = z.strictObject({
  org: MarketOrgId,
  publisher: MarketPublisher,
  keys: z.array(RegistryKeyLink).min(1).max(64),
});
export type RegistryKeyChain = z.infer<typeof RegistryKeyChain>;

/** `POST /v1/orgs/{org}/registry`: an owner opens the organization's registry under a handle. */
export const RegistryCreate = z.strictObject({ handle: MarketHandle });
export type RegistryCreate = z.infer<typeof RegistryCreate>;

/** One entry of a registry, as its members read the list. */
export const RegistryEntry = z.strictObject({
  type: MarketEntryType,
  name: MarketEntryName,
  title: z.string().max(120),
  /** Its newest signed version, absent before the first is signed. */
  latest: z.string().max(64).optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

/** `GET /v1/orgs/{org}/entries`: the registry's entries. Members only. */
export const RegistryEntries = z.strictObject({
  org: MarketOrgId,
  publisher: MarketPublisher,
  entries: z.array(RegistryEntry).max(5000),
});
export type RegistryEntries = z.infer<typeof RegistryEntries>;

/**
 * One version of a registry's entry as its admins read it (ADR 0206 amendment 5): its state, the
 * scan's verdict, and a withdrawal still waiting for the registry's signer.
 */
export const RegistryVersion = z.strictObject({
  version: MarketVersion,
  hash: MarketHash,
  size: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  status: MarketVersionStatus,
  /** Waiting on a maintainer, not only on the signer. */
  held: z.boolean(),
  /** Why it is blocked or withdrawn, in plain words. */
  reason: z.string().max(500).optional(),
  /** The scan's verdict and the scanner that gave it; absent for a version never scanned. */
  scan: z
    .strictObject({ verdict: MarketScanVerdict, scanner: z.number().int().positive() })
    .optional(),
  /** Asked for and not signed yet: the version is still offered until the signer signs it. */
  withdrawal: z
    .strictObject({ reason: z.string().max(500), at: z.number().int().nonnegative() })
    .optional(),
});
export type RegistryVersion = z.infer<typeof RegistryVersion>;

/** An entry of the registry with its newest versions, newest first. */
export const RegistryAdminEntry = RegistryEntry.extend({
  versions: z.array(RegistryVersion).max(20),
});
export type RegistryAdminEntry = z.infer<typeof RegistryAdminEntry>;

/**
 * `GET /v1/orgs/{org}/registry`: every entry with its versions, for those who may publish to it
 * (`registry:publish`, or named by an owner).
 */
export const RegistryAdmin = z.strictObject({
  org: MarketOrgId,
  publisher: MarketPublisher,
  entries: z.array(RegistryAdminEntry).max(5000),
});
export type RegistryAdmin = z.infer<typeof RegistryAdmin>;
