import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBase64url, encodeBase64url } from "./index.ts";

/*
 * Proof that a machine credential's requester holds the host key it names (ADR 0190), as the
 * relay's Noise handshake proves it for `/host`. The daemon computes an X25519 secret between
 * its relay host key and the backend's published exchange key, and MACs the request with it: the
 * host id and the credential it asks the backend to issue. Only the holders of the two private
 * keys can make or check it, and a replay can only ask for that same credential again. Pure.
 */

const encoder = new TextEncoder();
const proofText = (hostId: string, credential: string) =>
  encoder.encode(`ace-machine-credential/v1\n${hostId}\n${credential}`);

/** The daemon's proof, base64url. */
export function machineCredentialProof(input: {
  hostPrivateKey: Uint8Array;
  exchangeKey: string;
  hostId: string;
  credential: string;
}): string {
  const shared = x25519.getSharedSecret(input.hostPrivateKey, decodeBase64url(input.exchangeKey));
  return encodeBase64url(hmac(sha256, shared, proofText(input.hostId, input.credential)));
}

/** Whether `proof` is the host key's proof for this host id and credential. Never throws. */
export function machineCredentialProofValid(input: {
  exchangePrivateKey: Uint8Array;
  hostKey: string;
  hostId: string;
  credential: string;
  proof: string;
}): boolean {
  try {
    const shared = x25519.getSharedSecret(input.exchangePrivateKey, decodeBase64url(input.hostKey));
    const expected = hmac(sha256, shared, proofText(input.hostId, input.credential));
    const given = decodeBase64url(input.proof);
    if (given.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index++)
      difference |= (expected[index] ?? 0) ^ (given[index] ?? 0);
    return difference === 0;
  } catch {
    return false;
  }
}

/**
 * The backend's exchange key pair, derived from a secret it already keeps (the account
 * encryption key), so a deployment configures nothing new and rotating that secret rotates it.
 */
export function exchangeKeyPair(secret: Uint8Array): { privateKey: Uint8Array; publicKey: string } {
  const privateKey = hkdf(
    sha256,
    secret,
    undefined,
    encoder.encode("ace machine credential exchange v1"),
    32,
  );
  return { privateKey, publicKey: encodeBase64url(x25519.getPublicKey(privateKey)) };
}
