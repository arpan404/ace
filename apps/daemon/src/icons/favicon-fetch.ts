import { publicGet, type PublicFetchOptions } from "./public-fetch.ts";

/*
 * A site's favicon, fetched the way any visitor could, through the public-web fetch (no local
 * network, no credentials): `<origin>/favicon.ico`, else the icon the site's home page declares
 * with `<link rel="icon">` (or its touch icon). No provider reports the icon of the page an agent
 * loaded, so there is no cheaper source to read first.
 */

/** The icons a page declares, best first: plain icons, then touch icons. */
export function declaredIcons(html: string, base: string): string[] {
  const plain: string[] = [];
  const touch: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href =
      /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!href || !/\bicon\b/.test(rel) || href.startsWith("data:")) continue;
    try {
      const url = new URL(href, base).href;
      (rel.includes("apple-touch") ? touch : plain).push(url);
    } catch {
      /* A malformed href is just not an icon. */
    }
  }
  return [...new Set([...plain, ...touch])];
}

/**
 * The first favicon bytes the site serves. Null when it has none; undefined when an attempt
 * failed in a way that may pass (a timeout, the network, a 5xx), so the miss is not remembered.
 */
export async function fetchFavicon(
  origin: string,
  options: PublicFetchOptions = {},
): Promise<Buffer | null | undefined> {
  let transient = false;
  const icon = await publicGet(`${origin}/favicon.ico`, options);
  if (icon.kind === "ok") return icon.body;
  if (icon.kind === "failed") transient = true;
  if (icon.kind === "refused") return null;
  const page = await publicGet(`${origin}/`, {
    ...options,
    accept: "text/html",
    maxBytes: 512 * 1024,
  });
  if (page.kind === "failed") transient = true;
  if (page.kind === "ok" && /html/i.test(page.contentType))
    for (const url of declaredIcons(page.body.toString("utf8"), page.url).slice(0, 2)) {
      const declared = await publicGet(url, options);
      if (declared.kind === "ok") return declared.body;
      if (declared.kind === "failed") transient = true;
    }
  return transient ? undefined : null;
}
