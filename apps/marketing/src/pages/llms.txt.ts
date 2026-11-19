import type { APIRoute } from "astro";
import { product, spade, statuses } from "../content/product.ts";
import { downloads } from "../content/release.ts";
import { routes } from "../content/routes.ts";
import { markdownPath } from "../seo/markdown.ts";
import {
  aceDefinition,
  agentsSentence,
  downloadLines,
  isAndIsNot,
  versionFacts,
} from "../seo/markdown-blocks.ts";
import { links } from "../site.ts";

/*
 * llms.txt (https://llmstxt.org): the site's index as plain Markdown, for AI assistants and
 * answer engines: what ace is, quotable key facts, what it is and is not, downloads, every page
 * with its Markdown version, agents and statuses. Every page's full text is in its .md file and
 * in llms-full.txt.
 */
export const GET: APIRoute = ({ site }) => {
  const href = (path: string) => (site ? new URL(path, site).href : path);
  const text = [
    `# ${product.name}`,
    "",
    `> ${aceDefinition}`,
    "",
    product.about,
    "",
    "## Key facts",
    "",
    ...[...product.facts, ...versionFacts(downloads)].map((fact) => `- ${fact}`),
    `- ${agentsSentence}`,
    `- ${spade.name} is ace's own assistant, in beta and off until switched on in Settings › Beta: bots with memory, routines and a computer of their own, on your own models.`,
    "",
    ...isAndIsNot(),
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
    "## Thread status",
    "",
    "A thread's status in ace covers every subagent and background command it started.",
    "",
    ...statuses.map((status) => `- ${status.word}: ${status.meaning}`),
    "",
  ].join("\n");

  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
