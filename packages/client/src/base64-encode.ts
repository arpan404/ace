import { ClientError } from "./types.ts";

// Upload-only, so it loads with the transfers rather than with `base64.ts` (ADR 0056).
/** Encode one bounded byte chunk without building an unbounded intermediate string. */
export function encodeBase64(bytes: Uint8Array): string {
  if (bytes.length > 65536) throw new ClientError("limit");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0,
      b = bytes[i + 1] ?? 0,
      c = bytes[i + 2] ?? 0;
    result += alphabet[a >> 2];
    result += alphabet[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=";
    result += i + 2 < bytes.length ? alphabet[c & 63] : "=";
  }
  return result;
}
