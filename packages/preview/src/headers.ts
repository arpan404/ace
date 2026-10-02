import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

export const httpCookieName = "ace_preview_session";
export const httpsCookieName = "__Host-ace_preview_session";
const reserved = new Set([httpCookieName, httpsCookieName]);
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
    const url = value.startsWith("//")
      ? new URL(value, `http://localhost:${port}`)
      : new URL(value);
    if (
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port
    ) {
      return `${origin}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    /* Relative redirects already resolve against the preview origin. */
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
