/*
 * Where a web address opens when the person follows a link. ace's own browser comes first: a
 * plain click opens it there whenever the screen has one (a thread's). ⌘-click on a Mac, or
 * Ctrl-click on Windows and Linux, and a middle click open it in the system's browser instead.
 * An address on this computer or its network always opens in ace's browser: the daemon's
 * browser reaches it from any device, the system's browser on a phone or another computer may
 * not.
 */

export type LinkDestination = "app" | "system";

/** The parts of a click that pick where a link opens. */
export interface LinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** The platform's "open elsewhere" click: ⌘ on Apple, Ctrl elsewhere, or the middle button. */
export function asksForSystemBrowser(click: LinkClick | undefined, apple: boolean): boolean {
  if (!click) return false;
  if (click.button === 1) return true;
  return apple ? click.metaKey : click.ctrlKey;
}

/**
 * Where `url` opens. `inApp` says whether this screen has ace's browser to open it in.
 */
export function linkDestination(input: {
  url: string;
  click: LinkClick | undefined;
  apple: boolean;
  inApp: boolean;
}): LinkDestination {
  if (!input.inApp) return "system";
  if (isLocalAddress(input.url)) return "app";
  return asksForSystemBrowser(input.click, input.apple) ? "system" : "app";
}

/**
 * A web address on this computer or its local network: `localhost` and `*.localhost`, loopback,
 * private and link-local IPv4 and IPv6, unspecified addresses and `.local` names.
 */
export function isLocalAddress(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.startsWith("[")) return localIpv6(host.slice(1, -1));
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return false;
  const [a, b] = [Number(parts[1]), Number(parts[2])];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

function localIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true;
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}
