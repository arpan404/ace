import type { APIRoute } from "astro";
import { acpAgents, builtInAgents } from "../content/agents.ts";
import {
  capabilities,
  faq,
  workbench,
  fleetPoints,
  product,
  statuses,
  toolFamilies,
} from "../content/product.ts";
import { downloads, formatSize, platformInfo, platforms } from "../content/release.ts";
import { routes } from "../content/routes.ts";
import { links } from "../site.ts";

/*
 * llms.txt (https://llmstxt.org): the site's facts as plain Markdown, for AI assistants and
 * answer engines that read it instead of the rendered page. Built from the same content the page
 * shows, so the two never disagree.
 */
const names = (list: { label: string }[]) => list.map((agent) => agent.label).join(", ");

export const GET: APIRoute = ({ site }) => {
  const href = (path: string) => (site ? new URL(path, site).href : path);
  const downloadLinks = platforms.map((platform) => {
    const { name, build } = platformInfo[platform];
    const { url, bytes } = downloads.byPlatform[platform];
    const what = bytes
      ? `ace ${downloads.version} for ${build}, ${formatSize(bytes)}`
      : `the latest release page, for ${build}`;
    return `- [Download for ${name}](${url}): ${what}`;
  });

  const text = [
    `# ${product.name}`,
    "",
    `> ${product.description}`,
    "",
    product.about,
    "",
    "## Links",
    "",
    ...downloadLinks,
    "- ace for iPhone, iPad and Android: pairs with your machines to follow and steer agents",
    `- [Release notes](${downloads.notesUrl})`,
    `- [Source code on GitHub](${links.source}): Apache-2.0`,
    `- [All releases](${links.releases})`,
    `- [Everything on this site in one file](${href("/llms-full.txt")})`,
    "",
    "## Pages",
    "",
    ...routes.map((entry) => `- [${entry.name}](${href(entry.path)}): ${entry.summary}`),
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
    "## Browser use, computer use and devices",
    "",
    ...capabilities.flatMap((capability) =>
      [`### ${capability.title}`, "", capability.body, ""].concat(
        capability.details.map((detail) => `- ${detail}`),
        [`- MCP tools: ${capability.tools.join(", ")}`, ""],
      ),
    ),
    "## Fleet",
    "",
    ...fleetPoints.map((point) => `- ${point.title}: ${point.body}`),
    "",
    "## MCP tools",
    "",
    "ace runs an MCP server for each agent session, so every CLI gets the same tools. The CLI's own permission mode decides what runs.",
    "",
    ...toolFamilies.map(
      (family) => `- ${family.family} (${family.purpose}): ${family.tools.join(", ")}`,
    ),
    "",
    "## More",
    "",
    ...workbench.map((item) => `- ${item.title}: ${item.body}`),
    "",
    "## FAQ",
    "",
    ...faq.flatMap((entry) => [`### ${entry.question}`, "", entry.answer, ""]),
  ].join("\n");

  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
