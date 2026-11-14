import { deflateSync, inflateSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { CompressibleDescription, CompressibleStatus } from "./compressible-answers.ts";

/*
 * Compression of `/v1/machine-calls` bodies (ADR 0088's rule, applied between daemons). Only
 * bodies that carry no secret beside text another party can influence are compressed, decided
 * per body: `status` and `describe` requests (an origin and thread ids), and their answers when
 * they match the strict shapes in compressible-answers.ts, every field at every depth named. A status answer holding a request for
 * the person (a browser tab's URL, an elicitation link) goes as it is. Each body is compressed
 * alone, and the device token travels in a header, never in a compressed body.
 */

/** Calls whose request and answer bodies may be compressed. */
const compressibleOps: ReadonlySet<string> = new Set(["status", "describe"]);
/** Bodies smaller than this go as they are: compressing them saves almost nothing. */
export const COMPRESS_MIN_BYTES = 1024;
/** The codings this build reads and writes, best first: zstd is cheaper than deflate on Bun. */
export const CALL_ENCODINGS = "zstd, deflate";

export type CallEncoding = "zstd" | "deflate";

export function compressibleOp(op: string): boolean {
  return compressibleOps.has(op);
}

/**
 * Whether the answer to `op` may be compressed: the op allows it and this body holds only fields
 * known to be safe. Anything else, including a field a newer build added, goes as it is.
 */
export function compressibleAnswer(op: string, body: unknown): boolean {
  if (op === "describe") return CompressibleDescription.safeParse(body).success;
  return op === "status" && CompressibleStatus.safeParse(body).success;
}

/**
 * The coding to use for a body the other side will read, from what it accepts (an
 * `Accept-Encoding` value); undefined means identity. A coding it gives `q=0` is never used.
 */
export function pickEncoding(accepts: string | undefined): CallEncoding | undefined {
  if (!accepts) return undefined;
  const offered = new Map<string, number>();
  for (const part of accepts.split(",")) {
    const [token, ...params] = part.trim().toLowerCase().split(";");
    if (!token) continue;
    const q = params.map((param) => param.trim().match(/^q=([0-9.]+)$/)?.[1]).find(Boolean);
    offered.set(token, q === undefined ? 1 : Number(q));
  }
  for (const encoding of ["zstd", "deflate"] as const) {
    const q = offered.get(encoding) ?? (offered.has("*") ? (offered.get("*") ?? 0) : 0);
    if (q > 0) return encoding;
  }
  return undefined;
}

export function encodeBody(body: Buffer, encoding: CallEncoding): Buffer {
  return encoding === "zstd" ? zstdCompressSync(body) : deflateSync(body);
}

/**
 * A received body as sent, under `encoding` (a `Content-Encoding` value). Throws for a coding
 * this build doesn't read, or one that expands past `maxBytes`.
 */
export function decodeBody(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const coding = encoding?.trim().toLowerCase();
  if (!coding || coding === "identity") return body;
  if (coding === "zstd") return zstdDecompressSync(body, { maxOutputLength: maxBytes });
  if (coding === "deflate") return inflateSync(body, { maxOutputLength: maxBytes });
  throw new Error("Unsupported content coding");
}
