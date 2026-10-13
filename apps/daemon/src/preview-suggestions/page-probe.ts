import { isIP } from "node:net";
import { faviconPng } from "../icons/favicon-image.ts";
import { fetchFavicon } from "../icons/favicon-fetch.ts";
import { publicGet, type PublicFetchOptions } from "../icons/public-fetch.ts";
import { reachOf } from "@ace/preview/detection";

/*
 * What a detected dev server shows: whether it answers HTTP at all, its page title and its
 * favicon. Uses the icon fetch from site icons, pinned to loopback and to the one port, so a
 * redirect or a declared icon elsewhere is never followed off the machine.
 */

export interface PageFacts {
  /** False when the port did not answer HTTP (a database, a socket that hung up). */
  http: boolean;
  title?: string;
  /** A small PNG as a `data:` URI. */
  iconUrl?: string;
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The page's `<title>`, with whitespace collapsed and common entities decoded. */
export function pageTitle(html: string): string | undefined {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html.slice(0, 262_144))?.[1];
  if (raw === undefined) return undefined;
  const text = raw
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number(name.slice(1));
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return entities[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 200) : undefined;
}

/** Fetch options that only ever reach `port` on this machine's loopback addresses. */
export function loopbackFetch(port: number, timeoutMs: number): PublicFetchOptions {
  return {
    resolve: async (host) => (host === "localhost" ? ["127.0.0.1", "::1"] : []),
    allowed: (address, candidate) =>
      candidate === port && isIP(address) !== 0 && reachOf(address) === "loopback",
    timeoutMs,
    maxRedirects: 2,
  };
}

/** GET `/` and the favicon of a loopback port. */
export async function probePage(port: number, timeoutMs = 1500): Promise<PageFacts> {
  const options = loopbackFetch(port, timeoutMs);
  const origin = `http://localhost:${port}`;
  const page = await publicGet(`${origin}/`, {
    ...options,
    accept: "text/html,*/*",
    maxBytes: 512 * 1024,
  });
  // A 4xx or an empty body still came from an HTTP server; a hang-up or a 5xx may pass.
  if (page.kind !== "ok" && page.kind !== "missing") return { http: false };
  const title =
    page.kind === "ok" && /html/i.test(page.contentType)
      ? pageTitle(page.body.toString("utf8"))
      : undefined;
  const bytes = await fetchFavicon(origin, options).catch(() => undefined);
  const png = bytes ? await faviconPng(bytes).catch(() => undefined) : undefined;
  return {
    http: true,
    ...(title ? { title } : {}),
    ...(png ? { iconUrl: `data:image/png;base64,${png.toString("base64")}` } : {}),
  };
}
