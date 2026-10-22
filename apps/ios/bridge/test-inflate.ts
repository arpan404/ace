import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";

/** Node's zlib standing in for Swift's (`NativeBytes.swift`) in bridge tests. Test-only. */
export function nodeInflate(bytes: Uint8Array, format: string): Uint8Array | null {
  const expand =
    format === "gzip"
      ? gunzipSync
      : format === "deflate"
        ? inflateSync
        : format === "deflate-raw"
          ? inflateRawSync
          : undefined;
  if (!expand) return null;
  try {
    return new Uint8Array(expand(bytes, { maxOutputLength: 16 * 1024 * 1024 }));
  } catch {
    return null;
  }
}
