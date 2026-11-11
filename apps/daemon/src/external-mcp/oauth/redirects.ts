/*
 * Redirect URIs (OAuth 2.1 §2.3, §8.4.2; RFC 8252; MCP authorization security). A client may
 * register HTTPS, loopback HTTP, or a native app's private-use scheme (RFC 8252 §7.1, such as
 * `cursor://…`); nothing carries a fragment. A request's redirect must equal a registered one,
 * with one allowance native apps need (RFC 8252 §7.3): a loopback redirect registered without a
 * port may come back with whatever port the app is listening on.
 */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const schemeSyntax = /^[a-z][a-z0-9+.-]*:/;
/** Schemes that load or run something in the browser, or are web schemes in disguise. */
const refusedSchemes = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
  "ftp:",
  "javascript:",
  "vbscript:",
  "data:",
  "file:",
  "blob:",
  "about:",
  "filesystem:",
  "view-source:",
]);

function parse(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}
/** A native app's own scheme (RFC 8252 §7.1): the code goes to an app, not a web page. */
function privateUse(url: URL, uri: string): boolean {
  return schemeSyntax.test(uri) && !refusedSchemes.has(url.protocol);
}
function loopback(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && loopbackHosts.has(url.hostname);
}
/** Whether a client may register this redirect URI. */
export function redirectAcceptable(uri: string): boolean {
  const url = parse(uri);
  if (!url || url.hash || uri.includes("#") || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return loopbackHosts.has(url.hostname);
  return privateUse(url, uri);
}
/** The registered redirect URI `requested` matches, or undefined. */
export function matchRedirect(
  requested: string,
  registered: readonly string[],
): string | undefined {
  if (!redirectAcceptable(requested)) return undefined;
  if (registered.includes(requested)) return requested;
  const asked = parse(requested);
  if (!asked || asked.protocol !== "http:" || !loopbackHosts.has(asked.hostname)) return undefined;
  // Native apps listen on whatever port is free: a registration without a port allows any.
  return registered.some((uri) => {
    const url = parse(uri);
    return (
      url !== undefined &&
      url.protocol === "http:" &&
      url.port === "" &&
      url.hostname === asked.hostname &&
      url.pathname === asked.pathname &&
      url.search === asked.search
    );
  })
    ? requested
    : undefined;
}
/**
 * Where the code goes, as the person approving is shown it: the host for a web or loopback
 * address, the scheme for an app's own. `this-device` means an app on whatever device the
 * sign-in happens on, which no document can vouch for (MCP: localhost redirect risks).
 */
export function redirectTarget(uri: string): {
  redirectHost: string;
  redirectKind: "web" | "this-device";
} {
  const url = parse(uri);
  if (!url) return { redirectHost: uri.slice(0, 253), redirectKind: "this-device" };
  if (loopback(url)) return { redirectHost: url.host, redirectKind: "this-device" };
  if (url.protocol === "https:") return { redirectHost: url.host, redirectKind: "web" };
  return { redirectHost: url.protocol, redirectKind: "this-device" };
}
/** Whether every redirect goes to this computer. */
export function loopbackOnly(uris: readonly string[]): boolean {
  return uris.every((uri) => redirectTarget(uri).redirectKind === "this-device");
}
/** The host the person is shown: where the code goes. */
export function redirectHost(uri: string): string {
  return redirectTarget(uri).redirectHost;
}
