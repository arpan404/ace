import { z } from "zod";

/**
 * One HTTP request and its response, carried over one ticketed `/serve` socket between ace's
 * hosted relay and a daemon (ADR 0117, docs/relay/README.md). Every WebSocket message is binary;
 * its first byte says what it is:
 *
 * - `1` head: UTF-8 JSON. Relay to daemon, the request ({@link RequestHead}); daemon to relay,
 *   the response's status and headers ({@link ResponseHead}).
 * - `2` body: the bytes that follow, at most {@link HTTP_CHUNK_BYTES}.
 * - `3` end: the body is complete.
 * - `4` abort: either side gave up; the rest is an optional UTF-8 reason, never shown to the
 *   caller. Closing the socket means the same.
 * - `5` credit: relay to daemon, a big-endian uint32 of response bytes the caller has taken.
 *   The daemon keeps at most {@link HTTP_RESPONSE_WINDOW} bytes unacknowledged.
 *
 * The relay sends head, body chunks and end; the daemon answers with the same three. The
 * request body is complete before the daemon sees the head, so only the response needs credit.
 */
export const HttpFrame = { head: 1, body: 2, end: 3, abort: 4, credit: 5 } as const;

/** The largest body chunk in one frame, under the relay's 64 KiB frame limit. */
export const HTTP_CHUNK_BYTES = 60 * 1024;
/** Response bytes a daemon may have in flight before the relay acknowledges them. */
export const HTTP_RESPONSE_WINDOW = 1024 * 1024;
/** The largest request body the relay forwards. */
export const HTTP_MAX_REQUEST_BYTES = 1024 * 1024;

const HeaderList = z.array(z.tuple([z.string().max(256), z.string().max(16 * 1024)])).max(256);

/**
 * The request, as the daemon should see it. `origin` and `prefix` give the public base the
 * caller used (`https://relay.acehq.dev` and `/m/<hostId>`), so the daemon can name its
 * canonical resource URL; `path` is what follows the prefix, with the query.
 */
export const RequestHead = z.object({
  method: z.string().regex(/^[A-Z]{1,16}$/),
  origin: z.url().max(512),
  prefix: z.string().regex(/^\/[!-~]{0,255}$/),
  path: z.string().startsWith("/").max(8192),
  headers: HeaderList,
});
export type RequestHead = z.infer<typeof RequestHead>;

export const ResponseHead = z.object({
  status: z.number().int().min(200).max(599),
  headers: HeaderList,
});
export type ResponseHead = z.infer<typeof ResponseHead>;

export type DecodedFrame =
  | { kind: "head"; head: unknown }
  | { kind: "body"; bytes: Uint8Array }
  | { kind: "end" }
  | { kind: "abort" }
  | { kind: "credit"; bytes: number };

function tagged(tag: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = tag;
  frame.set(payload, 1);
  return frame;
}

export function headFrame(head: RequestHead | ResponseHead): Uint8Array {
  return tagged(HttpFrame.head, new TextEncoder().encode(JSON.stringify(head)));
}

export function bodyFrame(bytes: Uint8Array): Uint8Array {
  if (bytes.length > HTTP_CHUNK_BYTES) throw new Error("Body chunk too large");
  return tagged(HttpFrame.body, bytes);
}

export const endFrame = (): Uint8Array => tagged(HttpFrame.end);
export const abortFrame = (): Uint8Array => tagged(HttpFrame.abort);

export function creditFrame(bytes: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes);
  return tagged(HttpFrame.credit, payload);
}

/** Splits a body into frame-sized chunks without copying. */
export function* chunks(bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += HTTP_CHUNK_BYTES)
    yield bytes.subarray(offset, offset + HTTP_CHUNK_BYTES);
}

/** Reads one frame. A head's JSON is returned unparsed: each side checks its own schema. */
export function decodeFrame(frame: Uint8Array): DecodedFrame {
  const payload = frame.subarray(1);
  switch (frame[0]) {
    case HttpFrame.head:
      return {
        kind: "head",
        head: JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payload),
        ),
      };
    case HttpFrame.body:
      return { kind: "body", bytes: payload };
    case HttpFrame.end:
      return { kind: "end" };
    case HttpFrame.abort:
      return { kind: "abort" };
    case HttpFrame.credit:
      if (payload.length !== 4) throw new Error("Invalid credit frame");
      return {
        kind: "credit",
        bytes: new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0),
      };
    default:
      throw new Error("Unknown HTTP frame");
  }
}

/** Hop-by-hop headers (RFC 9110 §7.6.1) and lengths the relay recomputes. */
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

/**
 * What the relay adds about the caller, and its own headers. The daemon learns nothing about
 * the caller's address.
 */
const relayAdded = /^(cf-|x-forwarded-|x-real-ip$|true-client-ip$|cdn-loop$|forwarded$|ace-relay-)/;

/**
 * Response headers a daemon may not set on the relay's shared origin: every machine's path
 * lives under one host name, so cookies and origin-wide policies would reach other machines.
 * Bodies pass as sent, so a compressed body would arrive mislabelled; handlers don't compress.
 */
const originWide = new Set([
  "set-cookie",
  "set-cookie2",
  "clear-site-data",
  "strict-transport-security",
  "alt-svc",
  "content-encoding",
  "public-key-pins",
  "service-worker-allowed",
]);

function listed(headers: Headers): Set<string> {
  const named = new Set<string>();
  for (const token of (headers.get("connection") ?? "").split(","))
    if (token.trim()) named.add(token.trim().toLowerCase());
  return named;
}

/** Request headers forwarded to the daemon. Authorization passes untouched. */
export function requestHeaders(headers: Headers): [string, string][] {
  const named = listed(headers);
  const kept: [string, string][] = [];
  for (const [name, value] of headers)
    if (!hopByHop.has(name) && !named.has(name) && !relayAdded.test(name)) kept.push([name, value]);
  return kept;
}

/** Response headers passed back to the caller. */
export function responseHeaders(headers: Headers): [string, string][] {
  const named = listed(headers);
  const kept: [string, string][] = [];
  for (const [name, value] of headers)
    if (!hopByHop.has(name) && !named.has(name) && !originWide.has(name) && !relayAdded.test(name))
      kept.push([name, value]);
  return kept;
}

/** Whether a response is a long-lived event stream, which the relay caps per host. */
export function isEventStream(head: ResponseHead): boolean {
  return head.headers.some(
    ([name, value]) =>
      name.toLowerCase() === "content-type" && value.toLowerCase().startsWith("text/event-stream"),
  );
}
