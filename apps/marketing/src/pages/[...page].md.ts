import type { APIRoute, GetStaticPaths } from "astro";
import { downloads } from "../content/release.ts";
import { routes } from "../content/routes.ts";
import { markdownPath, pageMarkdown } from "../seo/markdown.ts";

/* Each page's Markdown beside it, for AI agents: /features/fleet/ → /features/fleet.md. */
export const getStaticPaths = (() =>
  routes.map((entry) => ({
    params: { page: markdownPath(entry.path).slice(1, -".md".length) },
    props: { path: entry.path },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props, site }) => {
  const path = typeof props.path === "string" ? props.path : "/";
  const href = (to: string) => (site ? new URL(to, site).href : to);
  const text = pageMarkdown(path, href, downloads);
  if (!text) return new Response("Not found", { status: 404 });
  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
