import { ClientError, accessResponseError } from "@ace/client";
import { isPin } from "./trust.ts";

/**
 * Native pinned HTTPS and WSS transport foundation for Android production
 * pairing and paired connections.
 *
 * Mirrors the iOS `PinnedHTTP`/`PinnedSocket` rules
 * (`apps/ios/Sources/Host/PinnedHTTP.swift`,
 * `apps/ios/Sources/Host/PinnedSocket.swift`) and the daemon's Node pinning
 * (`apps/daemon/src/client-access.ts`): the QR-confirmed SHA-256 DER SPKI pin
 * plus the certificate's validity window authenticates the daemon, with the
 * single ADR 0097 exception for `*.ts.net` hosts presenting the publicly
 * trusted certificate Tailscale issues for that exact name.
 *
 * Split of duties:
 *
 * - This module validates everything that can be checked in JS: a well-formed
 *   pin is required on every call, origins and fixed `/v1/` paths are
 *   validated before the native bridge is touched, and responses are bounded
 *   at 1 MiB. No code, token or ticket leaves JS unless the pin is valid.
 * - The injected `NativePinnedHttp` (the Kotlin adapter in
 *   `modules/ace-native`, parity task A02.02) owns TLS: it verifies the pin
 *   and validity window from the handshake before the request is written,
 *   refuses redirects, and reports refusals as plain reason strings. The
 *   React Native default fetch/WebSocket must never carry pairing material.
 *
 * Until the Kotlin adapter exists, nothing here may authorize a connection:
 * construct the bridge only from the native module, never from `fetch`.
 */

/** Refusal reasons the native transport reports instead of a response. */
export type PinnedRefusal = "pin" | "redirect" | "offline" | "limit" | "invalid";

export class PinnedTransportError extends Error {
  readonly refusal: PinnedRefusal;
  constructor(refusal: PinnedRefusal, message?: string) {
    super(message ?? pinnedMessage(refusal));
    this.name = "PinnedTransportError";
    this.refusal = refusal;
  }
}

function pinnedMessage(refusal: PinnedRefusal): string {
  switch (refusal) {
    case "pin":
      return "This computer's identity doesn't match the pairing link. Nothing was sent.";
    case "redirect":
      return "That address tried to redirect the connection. Redirects are refused.";
    case "offline":
      return "This computer didn't respond. Check the connection and try again.";
    case "limit":
      return "The computer's reply was too large and was discarded.";
    case "invalid":
      return "This pairing request is malformed and was never sent.";
  }
}

export interface PinnedRequest {
  readonly method: "GET" | "POST";
  /** Fixed daemon path, always starting with `/v1/`. */
  readonly path: string;
  readonly body?: string | undefined;
  /** Device token or pairing credential: 64 lowercase hex, sent only after pin validation. */
  readonly token?: string | undefined;
}

export interface PinnedResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The Kotlin adapter. It must verify the SPKI pin and validity window during
 * the TLS handshake, before writing the request, and reject with an `Error`
 * whose message is exactly one `PinnedRefusal`.
 */
export type NativePinnedHttp = (input: {
  readonly origin: string;
  readonly fingerprint: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string | undefined;
  readonly token?: string | undefined;
}) => Promise<PinnedResponse>;

/** One request over native pinned HTTPS. The bridge supplies only a fixed `/v1/` path. */
export type PinnedHttp = (request: PinnedRequest) => Promise<PinnedResponse>;

/** Bounds matching iOS `PinnedHTTP.maximumResponse` and the daemon's 4 KiB request cap. */
export const MAX_PINNED_RESPONSE = 1_048_576;
const MAX_PINNED_BODY = 4096;
const MAX_PINNED_PATH = 256;

function utf8Length(text: string): number {
  return unescape(encodeURIComponent(text)).length;
}

/** Conservative subset of `CharacterSet.urlPathAllowed` used by iOS: no `?#`, no `..`. */
function isPathChars(path: string): boolean {
  for (let index = 0; index < path.length; index++) {
    const unit = path.charCodeAt(index);
    const allowed =
      (unit >= 0x30 && unit <= 0x39) ||
      (unit >= 0x41 && unit <= 0x5a) ||
      (unit >= 0x61 && unit <= 0x7a) ||
      unit === 0x2d ||
      unit === 0x2e ||
      unit === 0x5f ||
      unit === 0x7e ||
      unit === 0x21 ||
      unit === 0x24 ||
      unit === 0x26 ||
      unit === 0x27 ||
      unit === 0x28 ||
      unit === 0x29 ||
      unit === 0x2a ||
      unit === 0x2b ||
      unit === 0x2c ||
      unit === 0x3b ||
      unit === 0x3d ||
      unit === 0x3a ||
      unit === 0x40 ||
      unit === 0x2f ||
      unit === 0x25;
    if (!allowed) return false;
  }
  return true;
}

/** The daemon origin that is the only network authority: HTTPS, no credentials or fragment. */
export function validatePinnedOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new PinnedTransportError("invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new PinnedTransportError("invalid");
  }
  if (url.host === "") throw new PinnedTransportError("invalid");
  return `${url.protocol}//${url.host}/`;
}

/** The request URL is the bound origin plus the fixed `/v1/` path; nothing from any fragment. */
export function buildPinnedUrl(origin: string, path: string, method: string): string {
  const base = validatePinnedOrigin(origin);
  if (
    (method !== "GET" && method !== "POST") ||
    !path.startsWith("/v1/") ||
    utf8Length(path) > MAX_PINNED_PATH ||
    !isPathChars(path) ||
    path.includes("..")
  ) {
    throw new PinnedTransportError("invalid");
  }
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || url.protocol !== "https:") {
    throw new PinnedTransportError("invalid");
  }
  return url.href;
}

function validateBody(body: string | undefined): void {
  if (body !== undefined && utf8Length(body) > MAX_PINNED_BODY) {
    throw new PinnedTransportError("invalid");
  }
}

function validateToken(token: string | undefined): void {
  if (token !== undefined && !isPin(token)) throw new PinnedTransportError("invalid");
}

/**
 * Bind one daemon origin and its confirmed pin to the native bridge.
 * Throws `PinnedTransportError` without touching the network when the pin is
 * missing or malformed, so no credential can be sent before validated pinning.
 */
export function createPinnedHttp(
  native: NativePinnedHttp,
  binding: { origin: string; fingerprint: string },
): PinnedHttp {
  const origin = validatePinnedOrigin(binding.origin);
  const fingerprint = binding.fingerprint;
  if (!isPin(fingerprint)) throw new PinnedTransportError("invalid");
  return async (request) => {
    buildPinnedUrl(origin, request.path, request.method);
    validateBody(request.body);
    validateToken(request.token);
    let response: PinnedResponse;
    try {
      response = await native({
        origin,
        fingerprint,
        method: request.method,
        path: request.path,
        body: request.body,
        token: request.token,
      });
    } catch (error) {
      throw refusal(error);
    }
    if (typeof response?.status !== "number" || typeof response?.body !== "string") {
      throw new PinnedTransportError("invalid");
    }
    if (utf8Length(response.body) > MAX_PINNED_RESPONSE) throw new PinnedTransportError("limit");
    return response;
  };
}

const REFUSALS: readonly PinnedRefusal[] = ["pin", "redirect", "offline", "limit", "invalid"];

function refusal(error: unknown): PinnedTransportError {
  const reason = error instanceof Error ? error.message : error;
  if (typeof reason === "string" && (REFUSALS as readonly string[]).includes(reason)) {
    return new PinnedTransportError(reason as PinnedRefusal);
  }
  return new PinnedTransportError("offline");
}

/**
 * Remembers that the native layer refused this computer's TLS key. The SDK
 * folds every non-network credential failure into `auth`, so the reason is
 * kept beside it for the UI.
 */
export class TrustMonitor {
  #failure: "pin" | undefined;
  get failure(): "pin" | undefined {
    return this.#failure;
  }
  report(reason: string): void {
    if (reason === "pin") this.#failure = "pin";
  }
  clear(): void {
    this.#failure = undefined;
  }
}

/** The SDK's HTTP status policy applies; transport refusals keep their own reason. */
export async function accessJson(
  http: PinnedHttp,
  request: PinnedRequest,
  trust?: TrustMonitor | undefined,
): Promise<unknown> {
  let response: PinnedResponse;
  try {
    response = await http(request);
  } catch (error) {
    const reason = error instanceof PinnedTransportError ? error.refusal : "offline";
    trust?.report(reason);
    if (reason === "pin")
      throw new ClientError("auth", "TLS public-key fingerprint mismatch");
    if (reason === "redirect") throw new ClientError("protocol", "Redirect refused");
    if (reason === "limit") throw new ClientError("limit", "Response too large");
    if (reason === "invalid") throw new ClientError("protocol", "Invalid pairing request");
    throw new ClientError(
      "offline",
      "Couldn't reach this computer. Check the connection and try again.",
    );
  }
  if (response.status !== 200) throw accessResponseError(response.status);
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new ClientError("protocol", "Invalid JSON response");
  }
}

/**
 * Validate a WSS endpoint the way iOS `ConnectionTarget.validate` does:
 * production requires pinned WSS; no credentials, query or fragment. There is
 * no loopback `ws` exception here: the debug fixture runtime stays separate.
 */
export function validateSocketTarget(url: string, fingerprint: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new PinnedTransportError("invalid");
  }
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new PinnedTransportError("invalid");
  }
  if (endpoint.pathname !== "" && endpoint.pathname !== "/") {
    throw new PinnedTransportError("invalid");
  }
  if (endpoint.host === "" || !isPin(fingerprint)) {
    throw new PinnedTransportError("invalid");
  }
  return `wss://${endpoint.host}/`;
}
