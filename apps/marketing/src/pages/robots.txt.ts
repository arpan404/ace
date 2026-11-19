import type { APIRoute } from "astro";
import { robotsTxt } from "../seo/robots.ts";

/* Every crawler welcome, AI assistants and answer engines named one by one (seo/robots.ts). */
export const GET: APIRoute = ({ site }) =>
  new Response(robotsTxt(site ? new URL("/sitemap.xml", site).href : undefined), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
