/*
 * The browser tool's address bar and page history: what a person typed becomes an address (or a
 * reason it isn't one), and each browser tab remembers the pages it showed so Back and Forward
 * can return to them. Pure; no search engine is ever consulted.
 */

export type AddressResult =
  | { ok: true; url: string }
  | { ok: false; reason: "empty" | "not_address" | "scheme" };

const local =
  /^(localhost|[\w-]+\.localhost|[\w-]+\.local|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[[\da-f:]+\])(?::\d{1,5})?$/i;
const domain = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z][a-z\d-]{1,62}\.?(?::\d{1,5})?$/i;
const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/;

/**
 * Turn typed text into an address: `localhost:3000` and private addresses get http, other hosts
 * https, and an explicit http(s) address or `about:blank` is kept. Anything else is refused
 * with a reason; there is no web search behind the bar.
 */
export function parseAddress(input: string): AddressResult {
  const text = input.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (/^about:blank$/i.test(text)) return { ok: true, url: "about:blank" };
  const scheme = /^([a-z][\w+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (
    scheme &&
    (text.slice(scheme.length + 1).startsWith("//") || !/^\d/.test(text.slice(scheme.length + 1)))
  ) {
    if (scheme !== "http" && scheme !== "https") return { ok: false, reason: "scheme" };
    try {
      const url = new URL(text);
      return url.hostname ? { ok: true, url: url.href } : { ok: false, reason: "not_address" };
    } catch {
      return { ok: false, reason: "not_address" };
    }
  }
  if (/\s/.test(text)) return { ok: false, reason: "not_address" };
  const slash = text.search(/[/?#]/);
  const host = slash < 0 ? text : text.slice(0, slash);
  const isLocal = local.test(host);
  if (!isLocal && !domain.test(host) && !ipv4.test(host))
    return { ok: false, reason: "not_address" };
  try {
    return { ok: true, url: new URL(`${isLocal ? "http" : "https"}://${text}`).href };
  } catch {
    return { ok: false, reason: "not_address" };
  }
}

/** An address as the bar shows it at rest: no scheme for web pages, no lone trailing slash. */
export function displayAddress(url: string): string {
  if (!url || url === "about:blank") return "";
  if (!url.includes("://")) return url.replace(/\/$/, "");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/** "localhost:5173", the short name a tab shows for a page without a known title. */
export function addressHost(url: string): string | undefined {
  if (!url || url === "about:blank") return undefined;
  // The relay can report pages as typed ("localhost:5173/settings").
  if (!url.includes("://")) return url.split(/[/?#]/)[0] || undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Same page for history: ignores a trailing slash and the scheme the relay may have dropped. */
const pageKey = (url: string) => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

export function samePage(a: string, b: string): boolean {
  return pageKey(a) === pageKey(b);
}

export interface PageHistory {
  entries: readonly string[];
  index: number;
}

export const emptyHistory: PageHistory = { entries: [], index: -1 };

/**
 * The page now shows `url` (typed, or followed from a link): forward entries are dropped and it
 * becomes the newest, unless it is the page already shown. At most `limit` entries are kept.
 */
export function visitPage(history: PageHistory, url: string, limit = 50): PageHistory {
  const current = history.entries[history.index];
  if (current !== undefined && samePage(current, url)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), url].slice(-limit);
  return { entries, index: entries.length - 1 };
}

/** Move `delta` entries back (-1) or forward (1); the same history when there is none. */
export function stepHistory(history: PageHistory, delta: -1 | 1): PageHistory {
  const index = history.index + delta;
  return index < 0 || index >= history.entries.length ? history : { ...history, index };
}

export function canStep(history: PageHistory, delta: -1 | 1): boolean {
  const index = history.index + delta;
  return index >= 0 && index < history.entries.length;
}

export interface AddressSuggestion {
  url: string;
  /** Shown first: "localhost:5173/settings". */
  label: string;
  /** Where it comes from: "Dev server · web", "Visited". */
  detail: string;
}

/**
 * What the address bar suggests for typed text: known addresses whose shown form starts with it
 * first, then those containing it, each once, at most `limit`. Empty text lists them in order.
 */
export function suggestAddresses(
  input: string,
  known: readonly AddressSuggestion[],
  limit = 6,
): AddressSuggestion[] {
  const needle = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  const seen = new Set<string>();
  const unique = known.filter((each) => {
    const key = displayAddress(each.url).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!needle) return unique.slice(0, limit);
  const shown = (each: AddressSuggestion) => displayAddress(each.url).toLowerCase();
  const starts = unique.filter((each) => shown(each).startsWith(needle));
  const contains = unique.filter(
    (each) =>
      !shown(each).startsWith(needle) &&
      (shown(each).includes(needle) || each.label.toLowerCase().includes(needle)),
  );
  return [...starts, ...contains].slice(0, limit);
}

export interface BrowserFailure {
  /** What happened, as a heading. */
  title: string;
  /** What it means and what to do. */
  detail: string;
  /** Chromium's own code when there is one (ERR_CONNECTION_REFUSED), for searching. */
  code?: string;
  /** Taking control again (or once) would let the person retry. */
  needsControl?: boolean;
}

const netErrors: Record<string, (host: string) => Omit<BrowserFailure, "code">> = {
  ERR_CONNECTION_REFUSED: (host) => ({
    title: "This site can't be reached",
    detail: `${host} refused to connect. Is its server running?`,
  }),
  ERR_NAME_NOT_RESOLVED: (host) => ({
    title: "This site can't be reached",
    detail: `This machine couldn't find ${host}. Check the address.`,
  }),
  ERR_UNSAFE_PORT: (host) => ({
    title: "This port is blocked",
    detail: `Chromium won't open ${host}: its port is reserved for other services.`,
  }),
  ERR_INTERNET_DISCONNECTED: () => ({
    title: "No internet connection",
    detail: "This machine is offline.",
  }),
  ERR_CONNECTION_TIMED_OUT: (host) => ({
    title: "This site took too long to respond",
    detail: `${host} didn't answer in time.`,
  }),
  ERR_CERT_AUTHORITY_INVALID: (host) => ({
    title: "This connection isn't private",
    detail: `${host}'s certificate isn't trusted, so the page wasn't opened.`,
  }),
};

/**
 * A browser command's failure as a person reads it: Chromium's net errors by name, the browser
 * service's refusals (control held elsewhere, an origin waiting for approval) in plain words, and
 * unknown failures with a recovery step.
 */
export function describeBrowserFailure(message: string, url: string): BrowserFailure {
  const host = addressHost(url) ?? url;
  const net = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  if (net) {
    const known = netErrors[net];
    return known
      ? { ...known(host), code: net }
      : { title: "This page couldn't load", detail: `${host} didn't load.`, code: net };
  }
  if (/requires approval/i.test(message))
    return {
      title: "This site needs approval",
      detail: `ace's browser opens ${host} only once it's approved for this thread.`,
    };
  if (/another connection/i.test(message))
    return {
      title: "Another device is using this page",
      detail: "Someone took control of the thread's page from another device.",
    };
  if (/controller mismatch|controlled by/i.test(message))
    return {
      title: "The agent has the page",
      detail: "An agent took the page back. Take control to browse again.",
      needsControl: true,
    };
  if (/browser closed/i.test(message))
    return { title: "The page was closed", detail: "Open the address again to start a new page." };
  if (/paused/i.test(message))
    return { title: "The browser is paused", detail: "Resume the browser, then reload the page." };
  return {
    title: "This page couldn't load",
    detail: "Check the address and connection, then reload the page.",
  };
}
