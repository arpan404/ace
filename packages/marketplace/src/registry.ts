import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  GrantError,
  decodeBase64url,
  encodeBase64url,
  verifyRegistryKeyAttestation,
  type GrantKeySet,
} from "@ace/account-grant";
import { orgAllows } from "@ace/account-grant/org-roles";
import {
  RegistryKeyUpload,
  type MarketKeySet,
  type RegistryKeyChain,
  type RegistryKeyStatement,
  type VersionManifest,
} from "@ace/protocol/marketplace";
import {
  canonicalJson,
  marketPublicKey,
  SignatureError,
  verifyManifest,
  type MarketSigningKey,
} from "./signing.ts";

/*
 * An organization's private registry (ADR 0206 §5): the key chain devices pin, and the proofs
 * its signer sends. Pure: keys, clocks and grant keys come in as arguments.
 *
 * The chain's first key is published by an owner from the person's own session, with the account
 * backend's attestation of its exact upload: a statement that authorizes nothing, so the chain
 * the market serves holds no credential. Each later key is signed by the key
 * before it. Every key also signs its own statement, so whoever published it held its private
 * half.
 */

export class RegistryChainError extends Error {
  override name = "RegistryChainError";
}

const encoder = new TextEncoder();
const keyLabel = "ace-registry-key-v1";
const requestLabel = "ace-registry-request-v1";
/** How long before its attestation a key statement may have been written. */
const statementLeadMs = 10 * 60_000;
/** How far a signer's request time may be from the market's clock. */
export const registryRequestSkewMs = 5 * 60_000;

const keyText = (statement: RegistryKeyStatement) =>
  encoder.encode(`${keyLabel}\n${canonicalJson(statement)}`);

const sha256Url = (bytes: Uint8Array) => encodeBase64url(sha256(bytes));

function verifies(signature: string, message: Uint8Array, publicKey: string): boolean {
  try {
    return ed25519.verify(decodeBase64url(signature), message, decodeBase64url(publicKey));
  } catch {
    return false;
  }
}

/**
 * A key's upload: its statement, signed by the key itself and, for a later key, by `previous`.
 * The statement's `key` and `publicKey` are the new key's.
 */
export function signRegistryKey(
  statement: RegistryKeyStatement,
  key: MarketSigningKey,
  previous?: MarketSigningKey,
): RegistryKeyUpload {
  const own = marketPublicKey(key);
  if (statement.key !== own.id || statement.publicKey !== own.publicKey)
    throw new SignatureError("The statement names another key");
  if (statement.position > 0 !== (previous !== undefined))
    throw new SignatureError("Only a later key is signed by the key before it");
  if (previous && statement.previous !== previous.id)
    throw new SignatureError("The statement names another previous key");
  const text = keyText(statement);
  return RegistryKeyUpload.parse({
    statement,
    proof: encodeBase64url(ed25519.sign(text, key.privateKey)),
    ...(previous ? { rotation: encodeBase64url(ed25519.sign(text, previous.privateKey)) } : {}),
  });
}

/** One upload's statement, checked on its own: its form and its own key's proof. */
export function readRegistryKeyUpload(text: string): RegistryKeyUpload {
  let parsed;
  try {
    parsed = RegistryKeyUpload.safeParse(JSON.parse(text));
  } catch {
    throw new RegistryChainError("A registry key isn't in a form this build reads");
  }
  if (!parsed.success)
    throw new RegistryChainError("A registry key isn't in a form this build reads");
  const upload = parsed.data;
  if ((upload.statement.position === 0) !== (upload.statement.previous === undefined))
    throw new RegistryChainError("A registry key names the wrong key before it");
  if (!verifies(upload.proof, keyText(upload.statement), upload.statement.publicKey))
    throw new RegistryChainError("A registry key wasn't signed by itself");
  return upload;
}

/**
 * Whether `attestation` is the account backend's word for the first key's `upload`: made for an
 * owner of the organization (`registry:key`), the account that added the key, over this very
 * upload, within minutes after the statement says it was written.
 */
export function attestationProblem(
  input: { org: string; upload: string; attestation: string; statement: RegistryKeyStatement },
  grantKeys: GrantKeySet,
): string | undefined {
  let attested;
  try {
    attested = verifyRegistryKeyAttestation(input.attestation, grantKeys, input.upload);
  } catch (error) {
    if (error instanceof GrantError) return "the account service didn't attest it";
    throw error;
  }
  if (attested.org !== input.org || !orgAllows(attested.role, "registry:key"))
    return "it wasn't added by an owner of the organization";
  if (attested.account !== input.statement.addedBy) return "it names another owner";
  // The statement is written first, then attested.
  if (input.statement.at > attested.at || attested.at - input.statement.at > statementLeadMs)
    return "it was attested long before or after it was made";
  return undefined;
}

export interface VerifiedChain {
  org: string;
  /** Every key of the chain, first first, as a key set manifests verify against. */
  keys: MarketKeySet["keys"];
  /** The key that signs now: the chain's last. */
  current: MarketKeySet["keys"][number];
  statements: RegistryKeyStatement[];
  /** The upload texts, first first, as a device pins them. */
  uploads: string[];
}

/**
 * The chain checked from its first key: each key proved by itself, the first attested by the
 * account backend for an owner (skipped when `trustedFirst` is that very upload, which this device already
 * checked and pinned), each later one signed by the key before it. Throws `RegistryChainError`.
 */
export function verifyRegistryChain(
  chain: RegistryKeyChain,
  options: { grantKeys: GrantKeySet; trustedFirst?: string },
): VerifiedChain {
  const statements: RegistryKeyStatement[] = [];
  const keys: MarketKeySet["keys"] = [];
  chain.keys.forEach((link, position) => {
    const upload = readRegistryKeyUpload(link.upload);
    const statement = upload.statement;
    if (statement.org !== chain.org) throw new RegistryChainError("A key is another registry's");
    if (statement.position !== position) throw new RegistryChainError("The chain is out of order");
    if (keys.some((key) => key.id === statement.key))
      throw new RegistryChainError("The chain names a key twice");
    const before = keys[position - 1];
    if (!before) {
      if (link.upload !== options.trustedFirst) {
        const problem = attestationProblem(
          { org: chain.org, upload: link.upload, attestation: link.attestation, statement },
          options.grantKeys,
        );
        if (problem)
          throw new RegistryChainError(`The registry's first key is refused: ${problem}`);
      }
    } else {
      if (statement.previous !== before.id || !upload.rotation)
        throw new RegistryChainError("A key doesn't follow the key before it");
      if (!verifies(upload.rotation, keyText(statement), before.publicKey))
        throw new RegistryChainError("A key wasn't signed by the key before it");
      if (statement.at < (statements[position - 1]?.at ?? 0))
        throw new RegistryChainError("A key is older than the key before it");
    }
    statements.push(statement);
    keys.push({ id: statement.key, publicKey: statement.publicKey });
  });
  const current = keys.at(-1);
  if (!current) throw new RegistryChainError("The registry has no key");
  return { org: chain.org, keys, current, statements, uploads: chain.keys.map((l) => l.upload) };
}

/** The SHA-256 of a key's exact upload, base64url: what a person's trust names. */
export const registryUploadDigest = (upload: string) => sha256Url(encoder.encode(upload));

/** A public key's fingerprint as people compare it: its SHA-256's first 10 bytes, in hex groups. */
export function registryKeyFingerprint(publicKey: string): string {
  const hex = Array.from(sha256(decodeBase64url(publicKey)).slice(0, 10), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return hex.match(/.{4}/g)?.join(" ") ?? hex;
}

/** What a device pinned of a registry's chain: its uploads, first first. */
export interface RegistryPin {
  uploads: string[];
}

/**
 * How a verified chain stands against what this device pinned: `new` with no pin, `trusted` when
 * it extends the pin, `reset` when its first key is another (asked again, never followed
 * silently), `broken` when it drops or rewrites a pinned later key.
 */
export function chainStanding(
  chain: VerifiedChain,
  pin: RegistryPin | undefined,
): "new" | "trusted" | "reset" | "broken" {
  if (!pin) return "new";
  if (chain.uploads[0] !== pin.uploads[0]) return "reset";
  if (chain.uploads.length < pin.uploads.length) return "broken";
  return pin.uploads.every((upload, index) => chain.uploads[index] === upload)
    ? "trusted"
    : "broken";
}

/**
 * A registry version's manifest, verified against the organization's chain: signed by one of
 * its keys and naming that registry. Throws `SignatureError`.
 */
export function verifyRegistryManifest(
  signed: unknown,
  chain: Pick<VerifiedChain, "org" | "keys">,
): VersionManifest {
  const manifest = verifyManifest(signed, { keys: chain.keys });
  if (manifest.registry !== chain.org)
    throw new SignatureError("The manifest wasn't signed for this registry");
  return manifest;
}

/* ---------------------------------------------------------------- the signer's requests */

const requestText = (input: { method: string; path: string; at: number; body: Uint8Array }) =>
  encoder.encode(
    `${requestLabel}\n${input.method}\n${input.path}\n${input.at}\n${sha256Url(input.body)}`,
  );

/** The header the org signer sends: `<key id>.<at>.<signature>` over the request. */
export const registryProofHeader = "ace-registry-proof";

export function signRegistryRequest(
  key: MarketSigningKey,
  input: { method: string; path: string; at: number; body?: Uint8Array },
): string {
  const text = requestText({ ...input, body: input.body ?? new Uint8Array() });
  return `${key.id}.${input.at}.${encodeBase64url(ed25519.sign(text, key.privateKey))}`;
}

/**
 * Whether `header` proves the request was made by the holder of the registry's current key,
 * within `registryRequestSkewMs` of `now`.
 */
export function registryRequestProved(
  header: string | null,
  current: MarketKeySet["keys"][number],
  input: { method: string; path: string; body: Uint8Array; now: number },
): boolean {
  const match = /^([A-Za-z0-9_-]{1,64})\.(\d{1,15})\.([A-Za-z0-9_-]{86})$/.exec(header ?? "");
  if (!match) return false;
  const [, id, at, signature] = match;
  if (id !== current.id || !signature) return false;
  const time = Number(at);
  if (Math.abs(input.now - time) > registryRequestSkewMs) return false;
  return verifies(signature, requestText({ ...input, at: time }), current.publicKey);
}
