/*
 * The A2A Agent Card's signature (ADR 0202 §6; A2A 1.0.1 §8.4): a JWS (RFC 7515) over the card's
 * JSON Canonicalization Scheme form (RFC 8785) with its `signatures` left out, ES256 with this
 * machine's card key. The protected header names the key by its RFC 7638 thumbprint and says
 * where its JWK set is. Pure: the key comes in, JSON goes out.
 */
import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto";

/** A JSON value as RFC 8785 writes it: object keys in UTF-16 order, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    // Default sort compares UTF-16 code units, as the scheme asks.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("JSON has no number for NaN or Infinity");
  // ECMAScript's number and string forms are the scheme's.
  return JSON.stringify(value);
}

function base64url(bytes: Buffer | string): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A P-256 public key as a JWK (RFC 7517). */
export interface CardJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
}

/** The machine's card key: its private half, and its public JWK with its thumbprint as `kid`. */
export interface CardKey {
  privateKey: KeyObject;
  jwk: CardJwk;
}

/** The card key of a P-256 private key. */
export function cardKey(privateKey: KeyObject): CardKey {
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  if (exported.kty !== "EC" || exported.crv !== "P-256" || !exported.x || !exported.y)
    throw new Error("The card key isn't a P-256 key");
  const { x, y } = exported;
  // RFC 7638: the required members in lexicographic order, hashed.
  const kid = base64url(
    createHash("sha256")
      .update(JSON.stringify({ crv: "P-256", kty: "EC", x, y }))
      .digest(),
  );
  return { privateKey, jwk: { kty: "EC", crv: "P-256", x, y, kid, alg: "ES256", use: "sig" } };
}

/** `card` with one signature by `key`, any it had replaced. `jku` is where its JWK set is. */
export function signCard(
  card: Record<string, unknown>,
  key: CardKey,
  jku: string,
): Record<string, unknown> {
  const { signatures: _left, ...payload } = card;
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JOSE", kid: key.jwk.kid, jku }));
  const input = `${header}.${base64url(canonicalJson(payload))}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return { ...payload, signatures: [{ protected: header, signature: base64url(signature) }] };
}
