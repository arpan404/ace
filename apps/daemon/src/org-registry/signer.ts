import { encodeBase64url } from "@ace/account-grant";
import { marketPublicKey, marketSigningKey, type MarketSigningKey } from "@ace/marketplace";
import { readRegistryKeyUpload, signRegistryKey } from "@ace/marketplace/registry";
import { registrySignerIo, type RegistryFetch } from "@ace/marketplace/registry-io";
import {
  signPending,
  type BotTestRunner,
  type CodeChecker,
  type SignerReport,
} from "@ace/marketplace/signer";
import { RegistryKeyChain, type MarketKeySet } from "@ace/protocol/marketplace";
import { KeychainError, type RegistryKeychain, type RegistryKeys } from "./keychain.ts";

/*
 * An organization's signer (ADR 0206 §5.2), on the machine whose keychain holds the registry key:
 * it makes the key (and the next one, to rotate), and signs what waits in the registry with the
 * market signer's own core, so a registry version passes the same checks again on the bytes from
 * R2, the same scan, contract comparison and bot tests, before it is signed with `registry: <org>`.
 */

export interface RegistrySignerDeps {
  keychain: RegistryKeychain;
  /** The market, by path. */
  fetch: RegistryFetch;
  now: () => number;
  /** ace's market keys: the blocklist and official list the scan reads are signed with them. */
  trusted: MarketKeySet;
  testBot?: BotTestRunner | undefined;
  checkCode?: CodeChecker | undefined;
}

export class RegistrySignerError extends Error {
  override name = "RegistrySignerError";
}

/** A key's id, from its public half, so two machines never name two keys alike. */
const keyFrom = (seed: Uint8Array): MarketSigningKey => {
  const draft = marketSigningKey("draft", seed);
  return marketSigningKey(`reg-${marketPublicKey(draft).publicKey.slice(0, 16)}`, seed);
};

/** The chain as the market serves it to this registry's signer, proved with `key`. */
async function chainSeenWith(
  deps: Pick<RegistrySignerDeps, "fetch" | "now">,
  org: string,
  key: MarketSigningKey,
): Promise<MarketKeySet["keys"] | undefined> {
  const io = registrySignerIo({ org, key, now: deps.now, fetch: deps.fetch });
  const read = io.read ?? io.get;
  const served = RegistryKeyChain.safeParse(await read("/v1/signer/keys"));
  if (!served.success) return undefined;
  const keys = served.data.keys.map((link) => {
    const { statement } = readRegistryKeyUpload(link.upload);
    return { id: statement.key, publicKey: statement.publicKey };
  });
  // The market admits only the chain's current key; it must be this one.
  return keys.at(-1)?.id === key.id ? keys : undefined;
}

/**
 * The key this machine signs with now: the newest one the market's chain ends with. After a
 * rotation, until an owner publishes the new key, that is still the previous one.
 */
async function signingKey(deps: RegistrySignerDeps, org: string, keys: RegistryKeys) {
  for (const key of [keys.current, keys.previous])
    if (key) {
      const chain = await chainSeenWith(deps, org, key);
      if (chain) return { key, chain };
    }
  return undefined;
}

/**
 * Makes the registry's first key, or with `rotate` its next one (signed by the key before it),
 * in this machine's keychain. Answers the upload an owner publishes from their own ace app; the
 * key itself never leaves the keychain.
 */
export async function makeRegistryKey(
  deps: RegistrySignerDeps,
  input: { org: string; owner: string; rotate: boolean; seed: Uint8Array },
): Promise<{ key: MarketKeySet["keys"][number]; position: number; upload: string }> {
  const stored = await deps.keychain.read(input.org);
  const key = keyFrom(input.seed);
  const own = marketPublicKey(key);
  let position = 0;
  let previous: MarketSigningKey | undefined;
  if (input.rotate) {
    if (!stored) throw new RegistrySignerError("This machine has no registry key to rotate from.");
    const signing = await signingKey(deps, input.org, stored);
    if (!signing)
      throw new RegistrySignerError(
        "The market's key chain doesn't end with a key this machine holds; publish it first.",
      );
    previous = signing.key;
    position = signing.chain.length;
  } else if (stored)
    throw new RegistrySignerError(
      "This machine already holds this registry's key. Rotate it with --rotate instead.",
    );
  const upload = JSON.stringify(
    signRegistryKey(
      {
        format: "ace-registry-key",
        org: input.org,
        position,
        key: own.id,
        publicKey: own.publicKey,
        ...(previous ? { previous: previous.id } : {}),
        addedBy: input.owner,
        at: deps.now(),
      },
      key,
      previous,
    ),
  );
  await deps.keychain.write(input.org, { current: key, ...(previous ? { previous } : {}) });
  return { key: own, position, upload };
}

/** Signs what waits in the organization's registry with the key the market's chain ends with. */
export async function signRegistry(deps: RegistrySignerDeps, org: string): Promise<SignerReport> {
  const keys = await deps.keychain.read(org);
  if (!keys) throw new KeychainError("This machine's keychain holds no key for that registry.");
  const signing = await signingKey(deps, org, keys);
  if (!signing)
    throw new RegistrySignerError(
      "The registry's key chain on the market doesn't end with a key this machine holds.",
    );
  const io = registrySignerIo({ org, key: signing.key, now: deps.now, fetch: deps.fetch });
  return signPending(io, signing.key, deps.now, deps.trusted, {
    registry: { org, keys: { keys: signing.chain } },
    testBot: deps.testBot,
    checkCode: deps.checkCode,
  });
}

/** 32 random bytes for a new key. */
export const freshSeed = () => crypto.getRandomValues(new Uint8Array(32));
export const seedText = (seed: Uint8Array) => encodeBase64url(seed);
