import { z } from "zod";
import { MarketEntryName, MarketEntryType, MarketPublisher } from "./marketplace-base.ts";
import { MarketHandle } from "./marketplace-publisher.ts";
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
 * One link as the market serves it: the upload's exact text, and the owner's market grant that
 * named that text's digest. The grant is the account backend's countersignature (ADR 0206 §5.3):
 * it was minted for an owner of the organization, from the person's own session, for this one
 * request.
 */
export const RegistryKeyLink = z.strictObject({
  upload: z.string().min(1).max(4096),
  grant: z.string().min(1).max(4096),
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
