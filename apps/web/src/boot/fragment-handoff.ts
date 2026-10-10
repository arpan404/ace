import {
  loadTarget,
  targetFromFragment,
  type ConnectionStores,
  type DaemonTarget,
} from "./connection-settings.ts";

/** The bare pairing route creates a code; only a link carrying a code redeems one. */
export function pairingLinkFromUrl(url: URL): string | undefined {
  return url.pathname === "/pair" && new URLSearchParams(url.hash.slice(1)).get("code")
    ? url.href
    : undefined;
}

/**
 * What a `#token=…&daemon=…` link may do. The daemon opens the app with one for this machine,
 * but anyone can send such a link. It is taken silently only when it names a daemon on this
 * computer (or the one this window already uses) and would not replace a token the person
 * asked to remember. Anything else waits for them to confirm.
 */
export type Handoff =
  /** Nothing to hand over, or the link names the connection already stored. */
  | { kind: "none" }
  | { kind: "accept"; target: DaemonTarget }
  | { kind: "confirm"; target: DaemonTarget; reason: "elsewhere" | "replaces-remembered" };

export function handoffFromFragment(
  stores: ConnectionStores,
  fragment: string,
  fallbackUrl: string,
): Handoff {
  const target = targetFromFragment(fragment, fallbackUrl);
  if (!target) return { kind: "none" };
  const stored = loadTarget(stores, fallbackUrl);
  if (
    stored.target &&
    stored.target.token === target.token &&
    sameUrl(stored.target.url, target.url)
  )
    return { kind: "none" };
  if (!isLoopbackUrl(target.url) && !sameUrl(stored.url, target.url))
    return { kind: "confirm", target, reason: "elsewhere" };
  if (stored.remembered) return { kind: "confirm", target, reason: "replaces-remembered" };
  return { kind: "accept", target };
}

/** A daemon on this computer: `localhost`, 127.0.0.0/8 or `[::1]`. */
export function isLoopbackUrl(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
