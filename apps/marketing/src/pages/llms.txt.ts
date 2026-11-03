import type { APIRoute } from "astro";
import { acpAgents, builtInAgents } from "../content/agents.ts";
import { product, statuses } from "../content/product.ts";
import { downloads } from "../content/release.ts";
import { routes } from "../content/routes.ts";
import { downloadLines, markdownPath } from "../seo/markdown.ts";
import { links } from "../site.ts";

/*
 * llms.txt (https://llmstxt.org): the site's index as plain Markdown, for AI assistants and
 * answer engines: what ace is, quotable key facts, downloads, every page with its Markdown
 * version, agents and statuses. Every page's full text is in its .md file and in llms-full.txt.
 */
const names = (list: { label: string }[]) => list.map((agent) => agent.label).join(", ");

export const GET: APIRoute = ({ site }) => {
  const href = (path: string) => (site ? new URL(path, site).href : path);
  const text = [
    `# ${product.name}`,
    "",
    `> ${product.description}`,
    "",
    product.about,
    "",
    "## Key facts",
    "",
    ...product.facts.map((fact) => `- ${fact}`),
    "",
    "## Links",
    "",
    ...downloadLines(downloads),
    "- ace for iPhone and iPad (Android coming soon): follows and steers agents on every machine you pair or sign in to your ace account",
    `- [Release notes](${downloads.notesUrl})`,
    `- [Source code on GitHub](${links.source}): Apache-2.0`,
    `- [All releases](${links.releases})`,
    `- [Everything on this site in one file](${href("/llms-full.txt")})`,
    "",
    "## Pages",
    "",
    ...routes.map(
      (entry) =>
        `- [${entry.name}](${href(markdownPath(entry.path))}): ${entry.summary} Web page: ${href(entry.path)}`,
    ),
    "",
    "## Supported agents",
    "",
    `- Built in: ${names(builtInAgents)}.`,
    `- Through the Agent Client Protocol (ACP): ${names(acpAgents)}, and any other ACP agent.`,
    "- ace uses each agent's own logged-in CLI. It never asks for, stores or proxies provider credentials.",
    "",
    "## Thread status",
    "",
    "A thread's status covers every subagent and background command it started.",
    "",
    ...statuses.map((status) => `- ${status.word}: ${status.meaning}`),
    "",
  ].join("\n");

  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
