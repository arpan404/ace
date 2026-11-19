/*
 * The sitemap as text, from absolute page URLs and the date the site's words last changed.
 * Pure; pages/sitemap.xml.ts finds the date and the URLs.
 */

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A YYYY-MM-DD date, or undefined for anything that isn't one. */
export function dayOf(value: string | undefined): string | undefined {
  const day = value?.trim().slice(0, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

export function sitemapXml(urls: string[], lastmod: string | undefined): string {
  const stamp = lastmod ? `<lastmod>${lastmod}</lastmod>` : "";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${escape(url)}</loc>${stamp}</url>`),
    "</urlset>",
    "",
  ].join("\n");
}
