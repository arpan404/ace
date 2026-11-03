import type { APIRoute } from "astro";
import { downloads } from "../content/release.ts";
import { routes } from "../content/routes.ts";
import { pageMarkdown } from "../seo/markdown.ts";

/*
 * llms-full.txt: every page's Markdown (seo/markdown.ts) in one file, for assistants that want
 * the whole site in a single read. llms.txt is the short index.
 */
export const GET: APIRoute = ({ site }) => {
  const href = (path: string) => (site ? new URL(path, site).href : path);
  const pages = routes.flatMap((entry) => pageMarkdown(entry.path, href, downloads) ?? []);
  return new Response(pages.join("\n---\n\n"), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
