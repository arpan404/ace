import type { APIRoute } from "astro";
import { agentGuides } from "../content/agent-guides.ts";
import { features } from "../content/features.ts";
import { toolReference } from "../content/mcp.ts";
import { faq, product } from "../content/product.ts";

/*
 * llms-full.txt: every page's content as one Markdown file, for assistants that want the whole
 * site in a single read. llms.txt is the short index; both come from the same content files.
 */
export const GET: APIRoute = ({ site }) => {
  const href = (path: string) => (site ? new URL(path, site).href : path);
  const lines: string[] = [];
  const add = (...more: string[]) => lines.push(...more);

  add(`# ${product.name}`, "", `> ${product.description}`, "", product.about, "");

  add("## Features", "");
  for (const feature of features) {
    add(`### ${feature.headline}`, "", `Page: ${href(`/features/${feature.slug}/`)}`, "");
    add(feature.intro, "");
    for (const point of feature.points) add(`- ${point}`);
    add("");
    for (const section of feature.sections) {
      add(`#### ${section.heading}`, "");
      for (const paragraph of section.body) add(paragraph, "");
    }
    if (feature.tools.length) add(`MCP tools: ${feature.tools.join(", ")}`, "");
    for (const entry of feature.questions) add(`**${entry.question}** ${entry.answer}`, "");
  }

  add("## Agents", "");
  for (const guide of agentGuides) {
    add(`### ${guide.label}`, "", `Page: ${href(`/agents/${guide.slug}/`)}`, "", guide.what, "");
    for (const note of guide.notes) add(`- ${note}`);
    add("");
  }

  add("## MCP tools", "");
  for (const family of toolReference) {
    add(`### ${family.family}`, "", family.purpose, "");
    for (const tool of family.tools) add(`- \`${tool.name}\`: ${tool.does}`);
    add("");
  }

  add("## FAQ", "");
  for (const entry of faq) add(`### ${entry.question}`, "", entry.answer, "");

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
