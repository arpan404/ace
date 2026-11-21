import { timingSafeEqual } from "node:crypto";
import { isMachineLoopbackHost } from "./loopback.ts";

/*
 * What the machine's localhost proxy reads of a browser's request (ADR 0194): its credentials,
 * the target it names, and the headers that go on. Pure.
 */

/** The user name the partition's browser answers the proxy's challenge with; the secret is the password. */
export const proxyUser = "ace";
/** The proxy's challenge (`Proxy-Authenticate`), which Chromium answers through `login`. */
export const proxyChallenge = 'Basic realm="ace"';

/**
 * Whether a `Proxy-Authorization` header carries this proxy's secret. Only the partition the
 * proxy belongs to is given the secret, so any other caller (another process on this computer,
 * another session of the app) is refused. Compared in constant time.
 */
export function proxyAuthorizes(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const match = /^basic\s+([a-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return false;
  const given = Buffer.from(Buffer.from(match[1], "base64").toString("utf8"), "utf8");
  const expected = Buffer.from(`${proxyUser}:${secret}`, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A port on the machine's loopback, as a request named it. */
export interface ProxyTarget {
  host: string;
  port: number;
}

const portOf = (text: string): number | undefined => {
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : undefined;
};

/**
 * A CONNECT's authority (`localhost:5173`, `[::1]:443`): Chromium tunnels HTTPS and every
 * websocket this way. Undefined when it doesn't parse or its host isn't the machine's loopback.
 */
export function connectTarget(authority: string): ProxyTarget | undefined {
  const match = /^(\[[^\]]+\]|[^:[\]]+):(\d+)$/.exec(authority);
  if (!match?.[1] || !match[2]) return undefined;
  const port = portOf(match[2]);
  if (port === undefined || !isMachineLoopbackHost(match[1])) return undefined;
  return { host: match[1], port };
}

/**
 * A plain-HTTP request in absolute form (`GET http://localhost:3000/app.js`), as Chromium sends
 * one to an HTTP proxy, with the origin-form path it goes on as. Undefined unless it is `http:`
 * to the machine's loopback.
 */
export function forwardTarget(url: string): (ProxyTarget & { path: string }) | undefined {
  const parsed = URL.parse(url);
  if (!parsed || parsed.protocol !== "http:" || parsed.username || parsed.password)
    return undefined;
  const port = parsed.port ? portOf(parsed.port) : 80;
  if (port === undefined || !isMachineLoopbackHost(parsed.hostname)) return undefined;
  return { host: parsed.hostname, port, path: `${parsed.pathname}${parsed.search}` };
}

/** Headers about one hop, never passed on (RFC 9110 §7.6.1), and the proxy's own. */
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The headers of a request or response that go on to the other side, as `rawHeaders` pairs in
 * their order and case: without hop-by-hop ones, the proxy's own, and any `Connection` names.
 * Node frames the body again (length or chunks) on the next hop.
 */
export function forwardHeaders(raw: readonly string[]): string[] {
  const named = new Set<string>();
  for (let index = 0; index + 1 < raw.length; index += 2)
    if (raw[index]?.toLowerCase() === "connection")
      for (const token of (raw[index + 1] ?? "").split(","))
        if (token.trim()) named.add(token.trim().toLowerCase());
  const kept: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? "";
    const lower = name.toLowerCase();
    if (hopByHop.has(lower) || named.has(lower)) continue;
    kept.push(name, raw[index + 1] ?? "");
  }
  return kept;
}
