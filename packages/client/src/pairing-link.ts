/** A pairing link, read: where the daemon is, and what its fragment carries. */
export interface PairingLink {
  /** The daemon's HTTPS origin with a trailing slash, where `/v1/pair` is posted. */
  daemon: string;
  code: string;
  /** The daemon's public-key pin; empty when the link has none. */
  fingerprint: string;
  scopes: string[];
}

/**
 * Read a pairing link. A link that opens the daemon's own web app is `https://host:port/pair#…`;
 * one that opens a separately served web app (such as app.acehq.dev) names the daemon in its
 * fragment: `https://app/pair#host=https%3A%2F%2Fhost%3Aport&…`. Credentials stay in the
 * fragment either way, so no HTTP request carries them.
 */
export function parsePairingLink(text: string): PairingLink {
  const url = URL.parse(text.trim());
  if (!url || !web(url) || url.username || url.password || url.search || url.pathname !== "/pair")
    throw new Error("Use the complete pairing link from your host computer.");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const host = fragment.get("host");
  const daemon = host === null ? url : URL.parse(host);
  if (
    !daemon ||
    !web(daemon) ||
    daemon.username ||
    daemon.password ||
    (host !== null && daemon.href !== `${daemon.origin}/`)
  )
    throw new Error("This pairing link doesn't name a valid computer address.");
  return {
    daemon: `${daemon.origin}/`,
    code: fragment.get("code") ?? "",
    fingerprint: fragment.get("fingerprint") ?? "",
    scopes: (fragment.get("scopes") ?? "").split(",").filter((scope) => scope !== ""),
  };
}

/** The link a person opens to pair: on the daemon itself, or on a web app that names it. */
export function pairingLinkUrl(input: {
  daemon: string;
  fingerprint: string;
  code: string;
  scopes: readonly string[];
  /** Origin of a separately served web app; the daemon's own web app when absent. */
  app?: string | undefined;
}): string {
  const daemon = new URL(input.daemon).origin;
  const url = new URL("/pair", input.app ?? daemon);
  url.hash = new URLSearchParams({
    ...(input.app === undefined ? {} : { host: daemon }),
    fingerprint: input.fingerprint,
    code: input.code,
    scopes: input.scopes.join(","),
  }).toString();
  return url.toString();
}

function web(url: URL): boolean {
  return url.protocol === "https:" || url.protocol === "http:";
}
