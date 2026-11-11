import {
  maxSpadeImageBytes,
  maxSpadeRequestBytes,
  maxSpadeResponseBytes,
  maxSpadeUploadBytes,
  type SpadeMethod,
} from "@ace/protocol";

/** Body rules for `spade.http` (ADR 0117), with no I/O. */

const pathname = (path: string) => path.split("?")[0] ?? "";
const messageRoute = /^\/v1\/conversations(?:\/[^/]+\/messages)?$/;
const imageRoute = /^\/v1\/images\/[^/]+$/;

/**
 * The largest request body a route takes: a new conversation or a message, which may carry 8
 * images as base64, takes `maxSpadeUploadBytes`; every other route keeps a small cap.
 */
export function requestBodyLimit(method: SpadeMethod, path: string): number {
  return method === "POST" && messageRoute.test(pathname(path))
    ? maxSpadeUploadBytes
    : maxSpadeRequestBytes;
}

/** The largest answer the daemon forwards for a route: one image from `/v1/images/...`. */
export function responseBodyLimit(method: SpadeMethod, path: string): number {
  return method === "GET" && imageRoute.test(pathname(path))
    ? maxSpadeImageBytes
    : maxSpadeResponseBytes;
}

/** Whether an answer is forwarded as text; anything else (an image) goes as base64. */
export function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/x-ndjson" ||
    type === "application/javascript" ||
    type === "application/xml" ||
    type.endsWith("+xml")
  );
}

export class InvalidBase64 extends Error {
  constructor() {
    super("The body isn't valid base64");
    this.name = "InvalidBase64";
  }
}
const base64Characters = /^[A-Za-z0-9+/]*={0,2}$/;
/**
 * Decodes base64 that arrives in pieces of any length: each `push` returns the whole bytes it
 * completes and keeps the rest for the next. Work is proportional to the piece.
 */
export function base64Stream() {
  let carry = "";
  let ended = false;
  return {
    push(piece: string): Buffer {
      if (ended) throw new InvalidBase64();
      const text = carry + piece;
      const whole = text.length - (text.length % 4);
      carry = text.slice(whole);
      const quanta = text.slice(0, whole);
      if (!base64Characters.test(quanta)) throw new InvalidBase64();
      // Padding only ever closes the body.
      if (quanta.includes("=")) ended = true;
      return Buffer.from(quanta, "base64");
    },
    finish(): Buffer {
      if (carry === "") return Buffer.alloc(0);
      throw new InvalidBase64();
    },
  };
}

/**
 * An answer's body cut into pieces of at most `size` characters, never between the two halves
 * of a surrogate pair, so every piece is well-formed text on its own.
 */
export function splitBody(body: string, size: number): string[] {
  if (body.length <= size) return [body];
  const pieces: string[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(start + size, body.length);
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(body.slice(start, end));
    start = end;
  }
  return pieces;
}
