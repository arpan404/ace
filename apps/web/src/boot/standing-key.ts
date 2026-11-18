/**
 * This window's device key for proving the person's standing (ADR 0190): a P-256 key made in
 * WebCrypto with its private half not extractable, kept in this window's memory only and never
 * written anywhere. A person's grant names its public half, and each socket's proof is signed with
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
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
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
