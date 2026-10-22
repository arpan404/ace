import type { APIRoute } from "astro";
import { download } from "../content/release.ts";

/** The pages search engines should index. Absolute URLs need the site's address (SITE_URL). */
const pages = ["/"];

export const GET: APIRoute = ({ site }) => {
  const lastmod = download.publishedAt
    ? `<lastmod>${download.publishedAt.slice(0, 10)}</lastmod>`
    : "";
  const urls = site
    ? pages.map((path) => `  <url><loc>${new URL(path, site).href}</loc>${lastmod}</url>`)
    : [];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
