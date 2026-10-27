import type { APIRoute } from "astro";
import { routes } from "../content/routes.ts";
import { downloads } from "../content/release.ts";

/*
 * Every indexable page (routes.ts). Absolute URLs need the site's address (SITE_URL). The latest
 * release date stands in for lastmod: the site is rebuilt per release, and copy changes ship
 * with one.
 */
export const GET: APIRoute = ({ site }) => {
  const lastmod = downloads.publishedAt
    ? `<lastmod>${downloads.publishedAt.slice(0, 10)}</lastmod>`
    : "";
  const urls = site
    ? routes.map((entry) => `  <url><loc>${new URL(entry.path, site).href}</loc>${lastmod}</url>`)
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
