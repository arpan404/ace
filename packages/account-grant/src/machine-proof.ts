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
  return macValid(
    input.exchangePrivateKey,
    input.hostKey,
    proofText(input.hostId, input.credential),
    input.proof,
  );
}

/** Whether `proof` is the MAC of `text` under the secret this host key shares. Never throws. */
function macValid(
  exchangePrivateKey: Uint8Array,
  hostKey: string,
  text: Uint8Array,
  proof: string,
) {
  try {
    const shared = x25519.getSharedSecret(exchangePrivateKey, decodeBase64url(hostKey));
    const expected = hmac(sha256, shared, text);
    const given = decodeBase64url(proof);
    if (given.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index++)
      difference |= (expected[index] ?? 0) ^ (given[index] ?? 0);
    return difference === 0;
  } catch {
    return false;
  }
}

/** How long a machine's consent to join an organization stands once given (ADR 0206 §2.1). */
export const ORG_ENROLL_LIFETIME_MS = 5 * 60_000;

/**
 * A machine's consent to become one organization's host (ADR 0206 §2.1): the daemon gives it only
 * to a socket that proved its owner's standing (ADR 0190), and the backend enrolls the host only
 * with it, once. It names the host, the organization, the owner whose standing the daemon checked
 * (the enrolling session must be theirs), a nonce the backend spends, and when it lapses; it is a
 * MAC under the secret the host key shares with the backend's exchange key, so only this machine
 * makes it and only the backend checks it.
 */
export type OrgEnrollConsent = {
  hostId: string;
  org: string;
  account: string;
  nonce: string;
  expiresAt: number;
};
const consentText = (consent: OrgEnrollConsent) =>
  encoder.encode(
    `ace-org-enroll/v1\n${consent.hostId}\n${consent.org}\n${consent.account}\n${consent.nonce}\n${consent.expiresAt}`,
  );

/** The daemon's MAC over its consent, base64url. */
export function orgEnrollProof(input: {
  hostPrivateKey: Uint8Array;
  exchangeKey: string;
  consent: OrgEnrollConsent;
}): string {
  const shared = x25519.getSharedSecret(input.hostPrivateKey, decodeBase64url(input.exchangeKey));
  return encodeBase64url(hmac(sha256, shared, consentText(input.consent)));
}

/** Whether `proof` is this host key's consent, exactly as given. Never throws. */
export function orgEnrollProofValid(input: {
  exchangePrivateKey: Uint8Array;
  hostKey: string;
  consent: OrgEnrollConsent;
  proof: string;
}): boolean {
  return macValid(input.exchangePrivateKey, input.hostKey, consentText(input.consent), input.proof);
}

/**
 * How far an organization credential proof's time may be from the backend's clock (ADR 0206
 * §2.1): a captured proof renews that one credential again only within this.
 */
export const ORG_HOST_CREDENTIAL_SKEW_MS = 5 * 60_000;

/**
 * An org host's request for its organization credential (ADR 0206 §2.1), issued at enrollment
 * and renewed while the host is enrolled. No person's session is behind it: the host key is what
 * proves the machine, so the MAC names the host, the organization, the credential and the time
 * it was made. Only this machine makes it and only the backend checks it.
 */
export type OrgHostCredentialTerms = {
  hostId: string;
  org: string;
  credential: string;
  at: number;
};
const orgCredentialText = (terms: OrgHostCredentialTerms) =>
  encoder.encode(
    `ace-org-host-credential/v1\n${terms.hostId}\n${terms.org}\n${terms.credential}\n${terms.at}`,
  );

/** The daemon's MAC over its organization credential request, base64url. */
export function orgHostCredentialProof(input: {
  hostPrivateKey: Uint8Array;
  exchangeKey: string;
  terms: OrgHostCredentialTerms;
}): string {
  const shared = x25519.getSharedSecret(input.hostPrivateKey, decodeBase64url(input.exchangeKey));
  return encodeBase64url(hmac(sha256, shared, orgCredentialText(input.terms)));
}

/** Whether `proof` is this host key's request, exactly as made. Never throws. */
export function orgHostCredentialProofValid(input: {
  exchangePrivateKey: Uint8Array;
  hostKey: string;
  terms: OrgHostCredentialTerms;
  proof: string;
}): boolean {
  return macValid(
    input.exchangePrivateKey,
    input.hostKey,
    orgCredentialText(input.terms),
    input.proof,
  );
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
