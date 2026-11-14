import { Sha256 } from "@ace/client/sha256";

/*
 * The fake Spade names stored attachments by the hash real Spade uses. The hashing is the
 * client's (`Sha256`), the one implementation shared by every package that needs it.
 */

/** The SHA-256 of `bytes`, as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).hex();
}

/** The bytes of base64 `data` (a `data:` URL's payload too). */
export function base64Bytes(data: string): Uint8Array {
  const binary = atob(data.slice(data.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
