/*
 * Redirect URIs (OAuth 2.1 §2.3, §8.4.2; MCP authorization security): each is HTTPS or a
 * loopback HTTP address, carries no fragment, and a request's must match a registered one
 * exactly. The one allowance OAuth 2.1 requires: a loopback IP literal may name any port.
 */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const loopbackIps = new Set(["127.0.0.1", "[::1]"]);

function parse(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}
/** Whether a client may register this redirect URI. */
export function redirectAcceptable(uri: string): boolean {
  const url = parse(uri);
  if (!url || url.hash || uri.includes("#") || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && loopbackHosts.has(url.hostname);
}
/** Whether every registered redirect goes to this computer, which proves nothing about who. */
export function loopbackOnly(uris: readonly string[]): boolean {
  return uris.every((uri) => {
    const url = parse(uri);
    return url !== undefined && loopbackHosts.has(url.hostname);
  });
}
/** The registered redirect URI `requested` matches, or undefined. */
export function matchRedirect(
  requested: string,
  registered: readonly string[],
): string | undefined {
  if (!redirectAcceptable(requested)) return undefined;
  if (registered.includes(requested)) return requested;
  const asked = parse(requested);
  if (!asked || asked.protocol !== "http:" || !loopbackIps.has(asked.hostname)) return undefined;
  // Native apps listen on whatever port is free (RFC 8252 §7.3).
  const portless = (url: URL) => `${url.protocol}//${url.hostname}${url.pathname}${url.search}`;
  return registered.some((uri) => {
    const url = parse(uri);
    return url !== undefined && loopbackIps.has(url.hostname) && portless(url) === portless(asked);
  })
    ? requested
    : undefined;
}
/** The host the person is shown: where the code goes. */
export function redirectHost(uri: string): string {
  return parse(uri)?.host ?? uri;
}
