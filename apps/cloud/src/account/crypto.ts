import { encodeBase64url, decodeBase64url } from "@ace/account-grant";

/** Fills a buffer with random bytes. Injected so tests can control it. */
export type RandomBytes = (length: number) => Uint8Array;

const encoder = new TextEncoder();

/** A 32-byte random value as 43 base64url characters: session tokens, login ids, claims. */
export function opaqueToken(random: RandomBytes): string {
  return encodeBase64url(random(32));
}

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Hex SHA-256: what the database keeps instead of tokens, ids and secrets. */
export async function digest(value: string): Promise<string> {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two digests. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** PKCE (RFC 7636, S256) and an OAuth state value. */
export async function pkce(random: RandomBytes) {
  const verifier = encodeBase64url(random(32));
  return {
    verifier,
    challenge: encodeBase64url(await sha256(verifier)),
    state: encodeBase64url(random(32)),
  };
}

/**
 * AES-256-GCM with associated data: a value sealed for one row cannot be opened as another's.
 * The output is base64url of nonce, ciphertext and tag.
 */
export function sealer(hexKey: string, random: RandomBytes) {
  const raw = Uint8Array.from(hexKey.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async seal(plain: string, bound: string): Promise<string> {
      const iv = random(12);
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(bound) },
        await key,
        encoder.encode(plain),
      );
      const out = new Uint8Array(12 + sealed.byteLength);
      out.set(iv);
      out.set(new Uint8Array(sealed), 12);
      return encodeBase64url(out);
    },
    async open(sealed: string, bound: string): Promise<string> {
      const bytes = decodeBase64url(sealed);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: encoder.encode(bound) },
        await key,
        bytes.subarray(12),
      );
      return new TextDecoder().decode(plain);
    },
  };
}
export type Sealer = ReturnType<typeof sealer>;
