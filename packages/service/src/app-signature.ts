import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/*
 * The desktop app's key pair for a daemon it didn't start (ADR 0178 §12.8): a daemon the login
 * service or a terminal runs. The app keeps the private half in the OS keychain (Electron
 * `safeStorage`) and registers the public half with that daemon once, after a fresh ace sign-in.
 * Its page then proves it is the app's with an Ed25519 signature over the port it dials and the
 * daemon's run id, which is new on every daemon start: a signature a listener at another
 * address collects is worthless at the daemon's port, and one from an earlier run is worthless
 * in the next. The daemon keeps only the public half, so reading its database proves nothing.
 * Pure, apart from Node's Ed25519.
 */

/** An app key pair as the app stores it: the Ed25519 JWK halves, base64url. */
export interface AppKeyPair {
  /** The public key, 32 bytes. What the daemon stores. */
  x: string;
  /** The private key, 32 bytes. Only ever in the keychain-encrypted store and memory. */
  d: string;
}

const Raw = /^[A-Za-z0-9_-]{43}$/;
const Signature = /^[A-Za-z0-9_-]{86}$/;

/** A public key as the daemon accepts one at registration: 32 bytes, base64url. */
export function isAppPublicKey(value: unknown): value is string {
  return typeof value === "string" && Raw.test(value);
}

/** A new key pair from `seed`, 32 random bytes the caller supplies. */
export function appKeyPair(seed: Uint8Array): AppKeyPair {
  if (seed.length !== 32) throw new Error("An app key seed is 32 bytes");
  // PKCS#8 for an Ed25519 seed: a fixed prefix, then the 32 bytes.
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = key.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string") throw new Error("Ed25519 export");
  return { x: jwk.x, d: jwk.d };
}

const message = (port: number, run: string) => Buffer.from(`ace-app/v1\n${port}\n${run}`);

/** The page's proof for the daemon run `run` listening on `port`: 86 base64url characters. */
export function appSocketSignature(pair: AppKeyPair, port: number, run: string): string {
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: pair.x, d: pair.d },
    format: "jwk",
  });
  return sign(null, message(port, run), key).toString("base64url");
}

/** Whether `proof` is a signature, by one of `publicKeys`, for this run on this port. */
export function appSignatureProven(
  publicKeys: readonly string[],
  port: number,
  run: string,
  proof: string,
): boolean {
  if (!Signature.test(proof)) return false;
  const signature = Buffer.from(proof, "base64url");
  return publicKeys.some((x) => {
    if (!Raw.test(x)) return false;
    try {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
      return verify(null, message(port, run), key, signature);
    } catch {
      return false;
    }
  });
}
