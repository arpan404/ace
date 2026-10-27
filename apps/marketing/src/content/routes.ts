import { agentGuides } from "./agent-guides.ts";
import { features } from "./features.ts";

/*
 * Every indexable page on the site, in one list. The navigation, footer, breadcrumbs, sitemap
 * and llms.txt all read it, so a page can't exist without being linked and listed.
 */

export interface Route {
  path: string;
  /** Short name for links and breadcrumbs. */
  name: string;
  /** One line for llms.txt and link lists. */
  summary: string;
  /** The page one level up, for breadcrumbs; the home page has none. */
  parent?: string;
}

export const routes: Route[] = [
  { path: "/", name: "Home", summary: "What ace is and what it does." },
  {
    path: "/download/",
    name: "Download",
    summary: "ace for Mac, Windows and Linux, and ace for iPhone, iPad and Android.",
    parent: "/",
  },
  {
    path: "/features/",
    name: "Features",
    summary: "Everything ace adds to the coding agents you already use.",
    parent: "/",
  },
  ...features.map((feature) => ({
    path: `/features/${feature.slug}/`,
    name: feature.name,
    summary: feature.description,
    parent: "/features/",
  })),
  {
    path: "/agents/",
    name: "Agents",
    summary: "The coding agents ace runs: built in, and any ACP agent.",
    parent: "/",
  },
  ...agentGuides.map((guide) => ({
    path: `/agents/${guide.slug}/`,
    name: guide.label,
    summary: `Run ${guide.label} in ace: ${guide.what}`,
    parent: "/agents/",
  })),
  {
    path: "/mcp/",
    name: "MCP tools",
    summary: "The MCP tools every agent gets in ace, in every CLI.",
    parent: "/",
  },
  {
    path: "/security/",
    name: "Security and privacy",
    summary: "Where your code goes, what ace holds, and what it never touches.",
    parent: "/",
  },
  { path: "/faq/", name: "FAQ", summary: "Questions people ask before trying ace.", parent: "/" },
];

export function route(path: string): Route {
  const found = routes.find((entry) => entry.path === path);
  if (!found) throw new Error(`No route for ${path}; add it to routes.ts`);
  return found;
}

/** The chain from the home page down to `path`, for breadcrumbs. */
export function trail(path: string): Route[] {
  const chain: Route[] = [];
  for (let at: Route | undefined = route(path); at; at = at.parent ? route(at.parent) : undefined) {
    chain.unshift(at);
  }
  return chain;
}
