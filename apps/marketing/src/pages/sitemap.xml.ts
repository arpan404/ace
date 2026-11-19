import type { APIRoute } from "astro";
import { routes } from "../content/routes.ts";
import { siteModified } from "../seo/modified.ts";
import { sitemapXml } from "../seo/sitemap.ts";

/*
 * Every indexable page (routes.ts), with the day the site's source last changed
 * (seo/modified.ts). Absolute URLs need the site's address (SITE_URL).
 */
export const GET: APIRoute = ({ site }) => {
  const urls = site ? routes.map((entry) => new URL(entry.path, site).href) : [];
  return new Response(sitemapXml(urls, siteModified), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
};
