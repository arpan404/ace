/*
 * How outside MCP clients reach this machine (ADR 0117, Reach): which base URL a request
 * arrived at on each way in, and the four endpoints Settings shows. Pure: facts in, answers out.
 * How a request arrived decides only its base URL, never what it may do.
 */
import type { OutsideEndpoint } from "@ace/protocol";
import { outsideBase, resourceOf, type OutsideBase } from "./oauth/base.ts";

/** What the remote runtime knows about the ways in beyond loopback. */
export interface ReachFacts {
  /** The Tailscale listener's ts.net name and port while browsers trust it; else why not. */
  tailscale(): { name: string; port: number } | { problem: string };
  /** ace's relay registration: its public origin and this machine's host id; else why not. */
  relay(): { origin: string; hostId: string } | { problem: string };
}
/** Before the server listens, or without remote access. */
export const unreachable: ReachFacts = {
  tailscale: () => ({ problem: "Remote access isn't running." }),
  relay: () => ({ problem: "Remote access isn't running." }),
};

/** The person's choices: each path is off until they turn it on. */
export interface ReachSettings {
  tailscale: boolean;
  relay: boolean;
  /** `remote.mcpPublicUrl`: an https origin, or null. */
  custom: string | null;
}
/** Paths outside clients use; the Tailscale listener hands only these to them. */
export function outsidePath(path: string): boolean {
  return (
    path === "/mcp" ||
    path === "/token" ||
    path === "/register" ||
    path === "/authorize" ||
    path === "/authorize/wait" ||
    path.startsWith("/.well-known/oauth-")
  );
}
/** `remote.mcpPublicUrl` as the URL clients use: its origin (lowercase host, no :443). */
export function publicOrigin(value: string): string | null {
  try {
    const { origin } = new URL(value);
    return origin.startsWith("https://") ? origin : null;
  } catch {
    return null;
  }
}
/** Whether a proxy says it forwarded the request (RFC 7239, or the X-Forwarded-* family). */
function proxied(headers: Headers): boolean {
  for (const name of headers.keys())
    if (name === "forwarded" || name.startsWith("x-forwarded-")) return true;
  return false;
}
/**
 * The base a loopback request arrived at, from its Host: the loopback endpoint itself, or the
 * person's own public URL (`custom`, an origin) whose proxy forwards here keeping its Host.
 * A request a proxy forwarded is never the loopback endpoint, even when the proxy rewrote Host
 * to it: traffic from the internet must not pass for this computer's. Anything else is refused.
 */
export function loopbackBase(
  headers: Headers,
  port: number,
  custom: string | null,
): OutsideBase | undefined {
  const named = headers.get("host")?.toLowerCase();
  if (!named) return undefined;
  if (custom && named === new URL(custom).host) return outsideBase("custom", custom);
  if (proxied(headers)) return undefined;
  if ([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(named))
    return outsideBase("local", `http://${named}`);
  return undefined;
}
function tailnetUrl(facts: { name: string; port: number }): string {
  return facts.port === 443 ? `https://${facts.name}` : `https://${facts.name}:${facts.port}`;
}
/**
 * The base a request on the Tailscale listener arrived at: only with the setting on, while the
 * ts.net certificate serves, and when it asked for the ts.net name (SNI and Host).
 */
export function tailscaleBase(
  request: { host: string | null; servername: string | null },
  facts: ReturnType<ReachFacts["tailscale"]>,
  settings: ReachSettings,
): OutsideBase | undefined {
  if (!settings.tailscale || "problem" in facts) return undefined;
  const url = tailnetUrl(facts);
  const expected = new URL(url).host;
  if (request.host?.toLowerCase() !== expected) return undefined;
  if (request.servername?.toLowerCase().replace(/\.$/, "") !== facts.name) return undefined;
  return outsideBase("tailscale", url);
}
/** ace's relay base for a forwarded request: `<origin><prefix>`, as the relay states it. */
export function relayBase(forwarded: { origin: string; prefix: string }): OutsideBase | undefined {
  if (!/^\/m\/[A-Za-z0-9_-]{1,128}$/.test(forwarded.prefix)) return undefined;
  try {
    const origin = new URL(forwarded.origin);
    if (origin.origin !== forwarded.origin) return undefined;
  } catch {
    return undefined;
  }
  return outsideBase("relay", forwarded.origin + forwarded.prefix);
}
function endpoint(
  name: OutsideEndpoint["path"],
  on: boolean,
  reached: string | { problem: string },
): OutsideEndpoint {
  if (!on) return { path: name, url: null, on: false };
  return typeof reached === "string"
    ? { path: name, url: reached, on: true }
    : { path: name, url: null, on: true, problem: reached.problem.slice(0, 512) };
}
/** The four ways in, with the URL to paste into a client and why one that's on can't serve. */
export function reachEndpoints(
  localUrl: string,
  facts: ReachFacts,
  settings: ReachSettings,
): OutsideEndpoint[] {
  const tailscale = facts.tailscale();
  const relay = facts.relay();
  return [
    { path: "local", url: localUrl, on: true },
    endpoint(
      "tailscale",
      settings.tailscale,
      "problem" in tailscale
        ? tailscale
        : resourceOf(outsideBase("tailscale", tailnetUrl(tailscale))),
    ),
    endpoint(
      "relay",
      settings.relay,
      "problem" in relay
        ? relay
        : resourceOf(outsideBase("relay", `${relay.origin}/m/${relay.hostId}`)),
    ),
    endpoint(
      "custom",
      settings.custom !== null,
      settings.custom === null ? "" : resourceOf(outsideBase("custom", settings.custom)),
    ),
  ];
}
