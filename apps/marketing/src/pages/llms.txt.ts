import type { APIRoute } from "astro";
import { acpAgents, builtInAgents } from "../content/agents.ts";
import {
  capabilities,
  faq,
  features,
  fleetPoints,
  product,
  statuses,
  toolFamilies,
} from "../content/product.ts";
import { download } from "../content/release.ts";
import { links } from "../site.ts";

/*
 * llms.txt (https://llmstxt.org): the site's facts as plain Markdown, for AI assistants and
 * answer engines that read it instead of the rendered page. Built from the same content the page
 * shows, so the two never disagree.
 */
const names = (list: { label: string }[]) => list.map((agent) => agent.label).join(", ");

export const GET: APIRoute = () => {
  const release = download.version
    ? `ace ${download.version} for macOS on Apple silicon`
    : "the latest release for macOS on Apple silicon";

  const text = [
    `# ${product.name}`,
    "",
    `> ${product.description}`,
    "",
    product.about,
    "",
    "## Links",
    "",
    `- [Download for Mac](${download.url}): ${release}`,
    `- [Release notes](${download.notesUrl})`,
    `- [Source code on GitHub](${links.source}): Apache-2.0`,
    `- [All releases](${links.releases})`,
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
    ...features.map((feature) => `- ${feature.title}: ${feature.body}`),
    "",
    "## FAQ",
    "",
    ...faq.flatMap((entry) => [`### ${entry.question}`, "", entry.answer, ""]),
  ].join("\n");

  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
