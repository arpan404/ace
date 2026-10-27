import { acpAgents, builtInAgents } from "../content/agents.ts";
import { features } from "../content/features.ts";
import { product, workbench } from "../content/product.ts";
import { downloads, platforms } from "../content/release.ts";
import { trail } from "../content/routes.ts";
import { links } from "../site.ts";

/*
 * schema.org nodes, composed per page into one JSON-LD @graph. Search engines use them for rich
 * results (breadcrumbs, FAQ, software), and AI assistants read them as the page's facts.
 *
 * Nodes refer to each other by @id, which must be absolute, so ids and urls are only written once
 * the site's address is known (SITE_URL); a relative @id is worse than none.
 */

export type Node = Record<string, unknown>;

export interface Schema {
  /** Absolute URL for a path, or undefined without SITE_URL. */
  at: (path: string) => string | undefined;
}

export function schemaFor(site: URL | undefined): Schema {
  return { at: (path) => (site ? new URL(path, site).href : undefined) };
}

const id = (schema: Schema, path: string, fragment: string) => {
  const url = schema.at(path);
  return url ? { "@id": `${url}#${fragment}` } : {};
};

/** The site itself; on every page. */
export function website(schema: Schema): Node {
  return {
    "@type": "WebSite",
    ...id(schema, "/", "website"),
    name: product.name,
    description: product.description,
    inLanguage: "en",
    ...(schema.at("/") ? { url: schema.at("/") } : {}),
  };
}

/** The page being read, tied to the site and to ace, which every page is about. */
export function webPage(
  schema: Schema,
  page: { path: string; title: string; description: string; type?: string },
): Node {
  const url = schema.at(page.path);
  const home = schema.at("/");
  const node: Node = {
    "@type": page.type ?? "WebPage",
    ...id(schema, page.path, "page"),
    name: page.title,
    description: page.description,
    inLanguage: "en",
  };
  if (url) node.url = url;
  if (home) {
    node.isPartOf = { "@id": `${home}#website` };
    node.about = { "@id": `${home}#app` };
  }
  if (url && page.path !== "/") node.breadcrumb = { "@id": `${url}#breadcrumb` };
  return node;
}

/** Home › Section › Page, from routes.ts. Not on the home page. */
export function breadcrumbs(schema: Schema, path: string): Node | undefined {
  if (path === "/") return undefined;
  return {
    "@type": "BreadcrumbList",
    ...id(schema, path, "breadcrumb"),
    itemListElement: listItems(schema, trail(path)),
  };
}

/* Numbered entries linking each page, for breadcrumbs and item lists. */
function listItems(schema: Schema, pages: { name: string; path: string }[]): Node[] {
  return pages.map((page, index) => {
    const entry: Node = { "@type": "ListItem", position: index + 1, name: page.name };
    const url = schema.at(page.path);
    if (url) entry.item = url;
    return entry;
  });
}

/** The pages an index page lists, in order. */
export function itemList(schema: Schema, pages: { name: string; path: string }[]): Node {
  return { "@type": "ItemList", itemListElement: listItems(schema, pages) };
}

/** ace as software: on the home and download pages, referred to by id everywhere else. */
export function softwareApplication(schema: Schema): Node {
  const agents = [...builtInAgents, ...acpAgents].map((agent) => agent.label);
  return {
    "@type": "SoftwareApplication",
    ...id(schema, "/", "app"),
    name: product.name,
    headline: product.headline,
    description: product.about,
    applicationCategory: product.category,
    applicationSubCategory: "AI coding agent manager",
    operatingSystem: product.operatingSystem,
    ...(schema.at("/") ? { url: schema.at("/"), image: schema.at("/og.png") } : {}),
    downloadUrl: platforms.map((platform) => downloads.byPlatform[platform].url),
    ...(downloads.version ? { softwareVersion: downloads.version } : {}),
    ...(downloads.publishedAt ? { datePublished: downloads.publishedAt } : {}),
    releaseNotes: downloads.notesUrl,
    license: links.license,
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    featureList: [
      ...features.map((feature) => `${feature.name}: ${feature.intro}`),
      ...workbench.map((item) => `${item.title}: ${item.body}`),
    ],
    softwareRequirements: `One or more coding-agent CLIs, such as ${builtInAgents
      .map((agent) => agent.label)
      .join(", ")}`,
    keywords: [
      "coding agents",
      "AI coding agent manager",
      "multi-agent orchestration",
      "computer use",
      "browser use",
      "iOS Simulator",
      "Android emulator",
      "MCP server",
      "git worktrees",
      ...agents,
    ].join(", "),
    sameAs: [links.source],
  };
}

export function sourceCode(schema: Schema): Node {
  return {
    "@type": "SoftwareSourceCode",
    name: `${product.name} source code`,
    codeRepository: links.source,
    programmingLanguage: ["TypeScript", "Swift"],
    license: links.license,
    ...(schema.at("/") ? { targetProduct: { "@id": `${schema.at("/")}#app` } } : {}),
  };
}

/** Questions and answers shown on the page, as FAQPage data. */
export function faqPage(
  schema: Schema,
  path: string,
  questions: { question: string; answer: string }[],
): Node {
  return {
    "@type": "FAQPage",
    ...id(schema, path, "faq"),
    mainEntity: questions.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}

/** Wraps a page's nodes into the document Base.astro writes as JSON-LD. */
export function graph(nodes: (Node | undefined)[]): Node {
  return {
    "@context": "https://schema.org",
    "@graph": nodes.filter((node): node is Node => node !== undefined),
  };
}
