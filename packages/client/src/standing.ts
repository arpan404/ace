import { pairedStandingText, standingProofText } from "@ace/account-grant";
import type { StandingChallenge } from "./api.ts";
import type { aceAccountClient } from "./ace-account.ts";

type AceAccountClient = ReturnType<typeof aceAccountClient>;

/**
 * A client's device key for proving the person's standing (ADR 0190): a P-256 key made in
 * WebCrypto with its private half not extractable. A window keeps it in its memory only and never
 * writes it anywhere. A person's grant names its public half, and each socket's proof is signed with
 * it, so a grant taken on the way, or read from any file, proves nothing without this window. A
 * new window makes a new key; grants last minutes, so nothing outlives it.
 */
export interface StandingKey {
  /** The public key, an uncompressed P-256 point, base64url. */
  publicKey: string;
  /** ECDSA P-256 SHA-256 over `text`, IEEE P1363, base64url. */
  sign(text: string): Promise<string>;
}

const encode = (bytes: ArrayBuffer) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export async function makeStandingKey(subtle: SubtleCrypto = crypto.subtle): Promise<StandingKey> {
  return standingKeyOf(await makeStandingKeyPair(subtle), subtle);
}

/** A new P-256 pair whose private half can't be exported, to keep (`standingKeyOf`). */
export function makeStandingKeyPair(subtle: SubtleCrypto = crypto.subtle): Promise<CryptoKeyPair> {
  return subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
}

/** The standing key a kept pair is, its private half still never exported. */
export async function standingKeyOf(
  pair: CryptoKeyPair,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<StandingKey> {
  const publicKey = encode(await subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey,
    sign: async (text) =>
      encode(
        await subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          new TextEncoder().encode(text),
        ),
      ),
  };
}

/**
 * The proof of the person's standing a client sends on one socket (ADR 0190): a person's grant
 * for the challenge's daemon and device, asked for with the person's own ace session, and `key`'s
 * signature over the challenge. Undefined when the backend gives no person's grant for that
 * session (not the person's, or one from before standing was kept).
 */
export async function proveStanding(input: {
  challenge: StandingChallenge;
  session: string;
  account: Pick<AceAccountClient, "grant">;
  key: StandingKey;
  signal?: AbortSignal;
}): Promise<{ grant: string; proof: string } | undefined> {
  const { challenge, key } = input;
  const minted = await input.account.grant(
    input.session,
    { kind: "device", subject: challenge.device, host: challenge.host, key: key.publicKey },
    input.signal ?? AbortSignal.timeout(15_000),
  );
  if (!minted.standing) return undefined;
  const proof = await key.sign(
    standingProofText({
      host: challenge.host,
      nonce: challenge.nonce,
      binding: challenge.binding,
      grant: minted.standing,
    }),
  );
  return { grant: minted.standing, proof };
}

/**
 * The proof of the person's standing a device paired from a person's link sends on one socket
 * (ADR 0190): `key`, the key it named when it redeemed that link, signing the challenge's host,
 * nonce and channel binding and its own device id. Its bearer token alone proves nothing.
 */
export async function provePaired(input: {
  challenge: StandingChallenge;
  key: StandingKey;
}): Promise<string> {
  const { challenge } = input;
  return input.key.sign(
    pairedStandingText({
      host: challenge.host,
      nonce: challenge.nonce,
      binding: challenge.binding,
      deviceId: challenge.device,
    }),
  );
}
