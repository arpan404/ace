/*
 * The ways in to the outside MCP endpoint (ADR 0122, Reach) as base URLs. Each base serves the
 * MCP endpoint at `<base>/mcp` (the OAuth resource) and is its own authorization server
 * (issuer `<base>`). A token issued at one base works only there.
 */
import type { OutsideEndpoint } from "@ace/protocol";

export type ReachPath = OutsideEndpoint["path"];

/** One way in: `url` is an origin plus an optional path prefix, without a trailing slash. */
export interface OutsideBase {
  path: ReachPath;
  url: string;
}

export function outsideBase(path: ReachPath, url: string): OutsideBase {
  return { path, url: url.replace(/\/+$/, "") };
}
/** The MCP URL clients use and name as `resource` (RFC 8707). */
export function resourceOf(base: OutsideBase): string {
  return `${base.url}/mcp`;
}
/**
 * The paths of the base's other resources: Spade's contracts over MCP and over A2A (ADR 0202
 * §3, §6). A client may name either at sign-in; the code and tokens it gets are bound to the
 * base's resource, `resourceOf(base)`, and work at all three.
 */
export const spadePaths = ["/spade/mcp", "/spade/a2a"] as const;
export type SpadePath = (typeof spadePaths)[number];
/** Every path Spade's contracts are served at below a base: its two resources, the key that
 * signs the Agent Card, and the card at A2A's well-known address. */
export const spadeContractPaths = [
  ...spadePaths,
  "/spade/jwks.json",
  "/.well-known/agent-card.json",
];
export function isSpadeContractPath(path: string | undefined): boolean {
  return spadeContractPaths.some((known) => known === path);
}
/** The base a resource URL belongs to; the inverse of `resourceOf`. */
export function baseOfResource(path: ReachPath, resource: string): OutsideBase {
  return outsideBase(path, resource.replace(/\/mcp$/, ""));
}
/**
 * Where the resource's metadata lives (RFC 9728 §3.1): `/.well-known/oauth-protected-resource`
 * inserted before the resource's path, at the origin. ace's relay forwards that form to the host
 * whose prefix follows it.
 */
export function resourceMetadataUrl(base: OutsideBase, path: "/mcp" | SpadePath = "/mcp"): string {
  const url = new URL(base.url);
  const prefix = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${prefix}${path}`;
}
/**
 * The request's path below its base, such as `/token`, or undefined when it isn't under it.
 * `request.url` is the public URL the client used.
 */
export function relativePath(request: Request, base: OutsideBase): string | undefined {
  const url = new URL(request.url);
  const prefix = new URL(base.url).pathname.replace(/\/$/, "");
  if (!prefix) return url.pathname;
  if (url.pathname === prefix) return "/";
  return url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : undefined;
}
/**
 * Whether `given` names this base's resource. Scheme and host compare without case (URL parsing
 * lowercases them) and a trailing slash is ignored; a query or fragment never matches.
 */
export function namesResource(given: string, base: OutsideBase): boolean {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return false;
  }
  if (url.search || url.hash || url.username || url.password) return false;
  const path = url.pathname.replace(/\/$/, "");
  const named = `${url.origin}${path}`;
  return named === resourceOf(base) || spadePaths.some((spade) => named === `${base.url}${spade}`);
}
