import { acpAgents, builtInAgents } from "../content/agents.ts";
import { agentGuides, agentQuestions, agentSetup } from "../content/agent-guides.ts";
import { features } from "../content/features.ts";
import { legalDocuments, type LegalBlock } from "../content/legal.ts";
import { toolReference } from "../content/mcp.ts";
import { boundary, faq, product, securityQuestions, statuses } from "../content/product.ts";
import {
  defaultArch,
  formatSize,
  platformInfo,
  platforms,
  type Downloads,
} from "../content/release.ts";
import { scenes } from "../content/stage.ts";
import { links } from "../site.ts";

/*
 * Every page as Markdown, for AI agents and answer engines that read text rather than HTML:
 * served beside each page (/features/fleet/ → /features/fleet.md), linked from its <head>, listed
 * in llms.txt and joined into llms-full.txt. Built from the same content files as the pages, so
 * the two never disagree.
 */

/** Turns a site path into an absolute URL once the site's address is known. */
export type Href = (path: string) => string;

/** Where a page's Markdown lives: "/" → "/index.md", "/features/fleet/" → "/features/fleet.md". */
export function markdownPath(path: string): string {
  return path === "/" ? "/index.md" : `${path.replace(/\/$/, "")}.md`;
}

const names = (list: { label: string }[]) => list.map((agent) => agent.label).join(", ");
const bullets = (items: readonly string[]) => items.map((item) => `- ${item}`);
const questions = (entries: { question: string; answer: string }[]) =>
  entries.flatMap((entry) => [`### ${entry.question}`, "", entry.answer, ""]);

/** One line per desktop download, with its build and size when the release is known. */
export function downloadLines(downloads: Downloads): string[] {
  return platforms.map((platform) => {
    const { name } = platformInfo[platform];
    const build = platformInfo[platform].builds[defaultArch[platform]];
    const { url, bytes } = downloads.byPlatform[platform];
    const what = bytes
      ? `ace ${downloads.version} for ${build}, ${formatSize(bytes)}`
      : `the latest release page, for ${build}`;
    return `- [Download for ${name}](${url}): ${what}`;
  });
}

const legalBlock = (block: LegalBlock) =>
  typeof block === "string" ? [block, ""] : [...bullets(block.list), ""];

function home(href: Href, downloads: Downloads): string[] {
  return [
    `# ${product.name}: ${product.headline}`,
    "",
    `> ${product.summary}`,
    "",
    product.about,
    "",
    "## Key facts",
    "",
    ...bullets(product.facts),
    "",
    "## How it works",
    "",
    ...scenes.flatMap((scene) => [
      `### ${scene.title}`,
      "",
      scene.body,
      "",
      `More: ${href(scene.href)}`,
      "",
    ]),
    "## Get ace",
    "",
    ...downloadLines(downloads),
    `- [Source code on GitHub](${links.source}): Apache-2.0`,
    "",
  ];
}

function download(downloads: Downloads): string[] {
  return [
    "# Download ace",
    "",
    "ace is free and open source. Install it on each computer that runs your agents, then sign in to the agent CLIs you use the way you normally do.",
    "",
    ...downloadLines(downloads),
    "- ace for iPhone and iPad follows and steers agents on every machine you pair or sign in to your ace account. Android is coming soon.",
    `- [Release notes](${downloads.notesUrl})`,
    `- [All releases](${links.releases})`,
    "",
  ];
}

function featureIndex(href: Href): string[] {
  return [
    "# Features",
    "",
    ...features.flatMap((feature) => [
      `## ${feature.name}`,
      "",
      feature.intro,
      "",
      `Page: ${href(`/features/${feature.slug}/`)}`,
      "",
    ]),
  ];
}

function featurePage(slug: string): string[] | undefined {
  const feature = features.find((entry) => entry.slug === slug);
  if (!feature) return undefined;
  return [
    `# ${feature.headline}`,
    "",
    feature.intro,
    "",
    ...bullets(feature.points),
    "",
    ...feature.sections.flatMap((section) => [
      `## ${section.heading}`,
      "",
      ...section.body.flatMap((p) => [p, ""]),
    ]),
    ...(feature.tools.length
      ? ["## MCP tools", "", feature.tools.map((tool) => `\`${tool}\``).join(", "), ""]
      : []),
    "## Questions",
    "",
    ...questions(feature.questions),
  ];
}

function agentIndex(href: Href): string[] {
  return [
    "# Agents ace runs",
    "",
    "ace runs each agent through its own logged-in CLI. It never asks for, stores or proxies provider credentials.",
    "",
    ...agentGuides.map(
      (guide) => `- [${guide.label}](${href(`/agents/${guide.slug}/`)}): ${guide.what}`,
    ),
    `- Through the Agent Client Protocol (ACP): ${names(acpAgents)}, and any other ACP agent.`,
    "",
  ];
}

function agentPage(slug: string, href: Href): string[] | undefined {
  const guide = agentGuides.find((entry) => entry.slug === slug);
  if (!guide) return undefined;
  return [
    `# Run ${guide.label} in ace`,
    "",
    guide.what,
    "",
    ...bullets(guide.notes),
    "",
    `## What ${guide.label} gets in ace`,
    "",
    ...features.map(
      (feature) =>
        `- [${feature.name}](${href(`/features/${feature.slug}/`)}): ${feature.points[0] ?? feature.intro}`,
    ),
    "",
    `## Set up ${guide.label}`,
    "",
    ...agentSetup(guide).map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Questions",
    "",
    ...questions(agentQuestions(guide)),
  ];
}

function mcp(): string[] {
  return [
    "# MCP tools every agent gets in ace",
    "",
    `ace runs an MCP server for every agent session, so ${names(builtInAgents)} and every ACP agent get the same tools.`,
    "",
    ...toolReference.flatMap((family) =>
      [`## ${family.family}`, "", family.purpose, ""].concat(
        family.tools.map((tool) => `- \`${tool.name}\`: ${tool.does}`),
        [""],
      ),
    ),
  ];
}

function security(): string[] {
  return [
    "# Security and privacy",
    "",
    ...boundary.flatMap((item) => [`## ${item.title}`, "", item.body, ""]),
    "## Questions",
    "",
    ...questions(securityQuestions),
  ];
}

function faqPage(): string[] {
  return [
    "# Questions about ace",
    "",
    ...questions(faq),
    "## Thread status",
    "",
    "A thread's status covers every subagent and background command it started.",
    "",
    ...statuses.map((status) => `- ${status.word}: ${status.meaning}`),
    "",
  ];
}

function legal(path: string): string[] | undefined {
  const document = legalDocuments.find((entry) => entry.path === path);
  if (!document) return undefined;
  return [
    `# ${document.headline}`,
    "",
    `Updated ${document.updated}.`,
    "",
    document.intro,
    "",
    ...document.sections.flatMap((section) =>
      [`## ${section.heading}`, ""].concat(section.body.flatMap(legalBlock)),
    ),
  ];
}

function linesFor(path: string, href: Href, downloads: Downloads): string[] | undefined {
  const fixed: Record<string, () => string[]> = {
    "/": () => home(href, downloads),
    "/download/": () => download(downloads),
    "/features/": () => featureIndex(href),
    "/agents/": () => agentIndex(href),
    "/mcp/": mcp,
    "/security/": security,
    "/faq/": faqPage,
  };
  const page = fixed[path];
  if (page) return page();
  const feature = /^\/features\/([^/]+)\/$/.exec(path)?.[1];
  if (feature) return featurePage(feature);
  const agent = /^\/agents\/([^/]+)\/$/.exec(path)?.[1];
  if (agent) return agentPage(agent, href);
  return legal(path);
}

/** A page's Markdown, or undefined for a path with no page. */
export function pageMarkdown(path: string, href: Href, downloads: Downloads): string | undefined {
  const lines = linesFor(path, href, downloads);
  if (!lines) return undefined;
  return `${[...lines, `Page: ${href(path)}`].join("\n").trim()}\n`;
}
