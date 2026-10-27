import type { APIRoute } from "astro";
import { acpAgents, builtInAgents } from "../content/agents.ts";
import { product, statuses } from "../content/product.ts";
import { defaultArch, downloads, formatSize, platformInfo, platforms } from "../content/release.ts";
import { routes } from "../content/routes.ts";
import { links } from "../site.ts";

/*
 * llms.txt (https://llmstxt.org): the site's index as plain Markdown, for AI assistants and
 * answer engines: what ace is, downloads, every page, agents and statuses. Feature, agent, tool
 * and FAQ content is in llms-full.txt, built from the same files, so nothing is said twice.
 */
const names = (list: { label: string }[]) => list.map((agent) => agent.label).join(", ");

export const GET: APIRoute = ({ site }) => {
  const href = (path: string) => (site ? new URL(path, site).href : path);
  const downloadLinks = platforms.map((platform) => {
    const { name } = platformInfo[platform];
    const build = platformInfo[platform].builds[defaultArch[platform]];
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
  ].join("\n");

  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
