import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

export const httpCookieName = "ace_preview_session";
export const httpsCookieName = "__Host-ace_preview_session";
/** The same session for a preview embedded in another site's frame (ADR 0008). */
export const httpEmbedCookieName = "ace_preview_embed";
export const httpsEmbedCookieName = "__Host-ace_preview_embed";
const reserved = new Set([
  httpCookieName,
  httpsCookieName,
  httpEmbedCookieName,
  httpsEmbedCookieName,
]);

/**
 * The gateway's cookie names, top-level first. Browsers drop a SameSite=Lax cookie set in a
 * cross-site frame, so an embedded preview needs its own partitioned SameSite=None cookie.
 */
export function sessionCookieNames(tls: boolean): readonly [string, string] {
  return tls ? [httpsCookieName, httpsEmbedCookieName] : [httpCookieName, httpEmbedCookieName];
}

/**
 * Both session cookies. The Lax one serves top-level visits (another browser, a phone). The
 * embedded one is Secure and Partitioned (CHIPS): browsers keep it only under the top-level
 * site that framed the preview, and accept Secure on http only on loopback names such as
 * `*.localhost`. Elsewhere over http the browser drops it and only top-level visits sign in.
 */
export function sessionCookies(session: string, tls: boolean, maxAgeSeconds: number): string[] {
  const [top, embedded] = sessionCookieNames(tls);
  const age = `Max-Age=${maxAgeSeconds}`;
  return [
    `${top}=${session}; Path=/; HttpOnly; SameSite=Lax; ${age}${tls ? "; Secure" : ""}`,
    `${embedded}=${session}; Path=/; HttpOnly; SameSite=None; ${age}; Secure; Partitioned`,
  ];
}
const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function cleanHeaders(input: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const connection = new Set(
    input.connection
      ?.toLowerCase()
      .split(",")
      .map((v) => v.trim()),
  );
  for (const [key, value] of Object.entries(input)) {
    if (
      !hop.has(key) &&
      !connection.has(key) &&
      key !== "forwarded" &&
      !key.startsWith("x-forwarded-")
    )
      out[key] = value;
  }
  return out;
}
export function cookieValue(header: string | undefined, name: string): string {
  return (
    header
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ""
  );
}
export function requestHeaders(input: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const out = cleanHeaders(input);
  out.host = `localhost:${port}`;
  if (input.origin) out.origin = `http://localhost:${port}`;
  if (input.cookie)
    out.cookie = input.cookie
      .split(";")
      .filter((c) => !reserved.has(c.trim().split("=")[0] ?? ""))
      .join(";");
  return out;
}
export function rewriteLocation(value: string, port: number, origin: string): string {
  try {
    // Use the browser's URL parser for mixed slash/backslash authorities too.
    const url = new URL(value, origin);
    if (
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port
    ) {
      return `${origin}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    /* Invalid redirect references retain their original value. */
  }
  return value;
}
export function responseHeaders(
  input: IncomingHttpHeaders,
  port: number,
  origin: string,
): OutgoingHttpHeaders {
  const out = cleanHeaders(input);
  if (input.location) out.location = rewriteLocation(input.location, port, origin);
  if (input["set-cookie"])
    out["set-cookie"] = input["set-cookie"]
      .filter((c) => !reserved.has((c.split("=")[0] ?? "").trim()))
      .map((c) => c.replace(/;\s*domain=[^;]*/gi, ""));
  return out;
}
