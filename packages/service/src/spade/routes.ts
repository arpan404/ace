import {
  maxSpadeImageBytes,
  maxSpadeRequestBytes,
  maxSpadeResponseBytes,
  maxSpadeUploadBytes,
  type SpadeMethod,
} from "@ace/protocol";

/*
 * Which of Spade's API routes a client may reach and how large their bodies may be, with no
 * I/O. The daemon's `spade.http` forwarder and the desktop app's direct path apply the same
 * rules (ADR 0121, ADR 0123).
 */

export type PathCheck = { ok: true; path: string } | { ok: false; message: string };
const refuse = (message: string): PathCheck => ({ ok: false, message });
const allowedCharacters = /^[A-Za-z0-9\-._~/%?=&+,:@!$'()*;]+$/;
/**
 * A path the daemon forwards to Spade: `/v1/` and onwards, no dot segments, empty segments,
 * fragments or encoded separators, so a client can never reach `/health` or leave the API.
 */
export function checkSpadePath(path: string): PathCheck {
  if (path.length > 2048) return refuse("The path is too long.");
  if (!path.startsWith("/v1/")) return refuse("Spade paths start with /v1/.");
  if (!allowedCharacters.test(path)) return refuse("The path has characters Spade doesn't use.");
  const [pathname = "", ...rest] = path.split("?");
  if (rest.length > 1) return refuse("The path has more than one query.");
  if (/%(2e|2f|5c|00)/i.test(pathname)) return refuse("The path encodes a separator.");
  if (/%(?![0-9a-f]{2})/i.test(path)) return refuse("The path has a broken escape.");
  const segments = pathname.slice(1).split("/");
  if (segments.some((segment, index) => segment === "" && index < segments.length - 1))
    return refuse("The path has an empty segment.");
  if (segments.some((segment) => segment === "." || segment === ".."))
    return refuse("The path has a dot segment.");
  return { ok: true, path };
}

/** A live path: a Spade API path whose last segment is `live`. */
export function checkLivePath(path: string): PathCheck {
  const checked = checkSpadePath(path);
  if (!checked.ok) return checked;
  const pathname = path.split("?")[0] ?? "";
  return pathname.endsWith("/live")
    ? checked
    : { ok: false, message: "Live streams are /v1/.../live paths." };
}

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
