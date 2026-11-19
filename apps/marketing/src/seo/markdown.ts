import type { Downloads } from "../content/release-download.ts";
import type { Href } from "./markdown-blocks.ts";
import { downloadMarkdown, homeMarkdown } from "./markdown-home.ts";
import {
  agentIndex,
  agentPage,
  faqMarkdown,
  featureIndex,
  featurePage,
  legalMarkdown,
  mcpPage,
  securityPage,
  spadeMarkdown,
} from "./markdown-pages.ts";

export { downloadLines, type Href } from "./markdown-blocks.ts";

/*
 * Every page as Markdown, for AI agents and answer engines that read text rather than HTML:
 * served beside each page (/features/fleet/ → /features/fleet.md), linked from its <head>, listed
 * in llms.txt and joined into llms-full.txt. Built from the same content files as the pages, so
 * the two never disagree. Each page opens with one sentence defining its subject; the pages
 * themselves are in markdown-home.ts and markdown-pages.ts.
 */

/** Where a page's Markdown lives: "/" → "/index.md", "/features/fleet/" → "/features/fleet.md". */
export function markdownPath(path: string): string {
  return path === "/" ? "/index.md" : `${path.replace(/\/$/, "")}.md`;
}

function linesFor(path: string, href: Href, downloads: Downloads): string[] | undefined {
  const fixed: Record<string, () => string[]> = {
    "/": () => homeMarkdown(href, downloads),
    "/download/": () => downloadMarkdown(href, downloads),
    "/features/": () => featureIndex(href),
    "/agents/": () => agentIndex(href),
    "/mcp/": mcpPage,
    "/spade/": spadeMarkdown,
    "/security/": securityPage,
    "/faq/": faqMarkdown,
  };
  const page = fixed[path];
  if (page) return page();
  const feature = /^\/features\/([^/]+)\/$/.exec(path)?.[1];
  if (feature) return featurePage(feature);
  const agent = /^\/agents\/([^/]+)\/$/.exec(path)?.[1];
  if (agent) return agentPage(agent, href);
  return legalMarkdown(path);
}

/** A page's Markdown, or undefined for a path with no page. */
export function pageMarkdown(path: string, href: Href, downloads: Downloads): string | undefined {
  const lines = linesFor(path, href, downloads);
  if (!lines) return undefined;
  return `${[...lines, `Web page: ${href(path)}`]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}
