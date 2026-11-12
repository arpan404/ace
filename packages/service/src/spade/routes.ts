import {
  maxSpadeAudioBytes,
  maxSpadeDocumentBytes,
  maxSpadeImageBytes,
  maxSpadeRequestBytes,
  maxSpadeResponseBytes,
  maxSpadeTranscriptionBytes,
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
 * Never `/v1/inbox` or under it: that is for other machines, through machine calls.
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
  // Only the daemon reaches the inbox, with the calling machine it stamps (ADR 0132).
  if (decodeURIComponent(segments[1] ?? "").toLowerCase() === "inbox")
    return refuse("Spade's inbox takes requests from other machines only.");
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
const documentRoute = /^\/v1\/documents\/[^/]+$/;
const audioRoute = /^\/v1\/audio\/[^/]+$/;

/**
 * The largest request body a route takes, as Spade takes it (`spade/docs/media.md`): a new
 * conversation or a message, which may carry 8 documents, 8 images and a recording as base64,
 * takes `maxSpadeUploadBytes`; a recording to transcribe `maxSpadeTranscriptionBytes`; every
 * other route keeps a small cap.
 */
export function requestBodyLimit(method: SpadeMethod, path: string): number {
  if (method !== "POST") return maxSpadeRequestBytes;
  const route = pathname(path);
  if (messageRoute.test(route)) return maxSpadeUploadBytes;
  if (route === "/v1/transcriptions") return maxSpadeTranscriptionBytes;
  return maxSpadeRequestBytes;
}

/**
 * The largest answer forwarded for a route: one stored image, document or recording takes its
 * own room; everything else (a document's `/text` window included) keeps the small cap.
 */
export function responseBodyLimit(method: SpadeMethod, path: string): number {
  if (method !== "GET") return maxSpadeResponseBytes;
  const route = pathname(path);
  if (imageRoute.test(route)) return maxSpadeImageBytes;
  if (documentRoute.test(route)) return maxSpadeDocumentBytes;
  if (audioRoute.test(route)) return maxSpadeAudioBytes;
  return maxSpadeResponseBytes;
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
