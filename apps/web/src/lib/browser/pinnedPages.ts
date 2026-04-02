import * as Schema from "effect/Schema";

export const BROWSER_PINNED_PAGES_STORAGE_KEY = "t3code:browser:pinned-pages:v1";
export const MAX_BROWSER_PINNED_PAGES = 24;

export const BrowserPinnedPageSchema = Schema.Struct({
  pinnedAt: Schema.Number,
  title: Schema.String,
  url: Schema.String,
});
export type BrowserPinnedPage = typeof BrowserPinnedPageSchema.Type;

export const BrowserPinnedPagesSchema = Schema.Array(BrowserPinnedPageSchema);
export type BrowserPinnedPages = typeof BrowserPinnedPagesSchema.Type;

function normalizePinnedPages(pages: BrowserPinnedPages): BrowserPinnedPages {
  const uniquePages = new Map<string, BrowserPinnedPage>();
  for (const page of pages) {
    if (page.url.trim().length === 0) {
      continue;
    }
    uniquePages.set(page.url, page);
  }

  return [...uniquePages.values()]
    .toSorted((left, right) => right.pinnedAt - left.pinnedAt)
    .slice(0, MAX_BROWSER_PINNED_PAGES);
}

export function isPinnedBrowserPage(pages: BrowserPinnedPages, url: string): boolean {
  return pages.some((page) => page.url === url);
}

export function addPinnedBrowserPage(
  pages: BrowserPinnedPages,
  page: BrowserPinnedPage,
): BrowserPinnedPages {
  if (page.url.trim().length === 0) {
    return pages;
  }

  const nextPages = [page, ...pages.filter((item) => item.url !== page.url)];
  return normalizePinnedPages(nextPages);
}

export function removePinnedBrowserPage(
  pages: BrowserPinnedPages,
  url: string,
): BrowserPinnedPages {
  return pages.filter((page) => page.url !== url);
}

export function togglePinnedBrowserPage(
  pages: BrowserPinnedPages,
  page: BrowserPinnedPage,
): BrowserPinnedPages {
  return isPinnedBrowserPage(pages, page.url)
    ? removePinnedBrowserPage(pages, page.url)
    : addPinnedBrowserPage(pages, page);
}

export function serializePinnedBrowserPages(pages: BrowserPinnedPages): string {
  return JSON.stringify(normalizePinnedPages(pages), null, 2);
}

export function parsePinnedBrowserPages(raw: string): BrowserPinnedPages {
  const parsed = JSON.parse(raw) as unknown;
  const decoded = Schema.decodeUnknownSync(BrowserPinnedPagesSchema)(parsed);
  return normalizePinnedPages(decoded);
}
