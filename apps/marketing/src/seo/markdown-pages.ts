import { acpAgents, builtInAgents, currentModels } from "../content/agents.ts";
import { agentGuides, agentQuestions, agentSetup } from "../content/agent-guides.ts";
import { features } from "../content/features.ts";
import { legalDocuments, type LegalBlock } from "../content/legal.ts";
import { toolReference } from "../content/mcp.ts";
import { boundary, faq, securityQuestions, statuses } from "../content/product.ts";
import { roster, rosterFacts } from "../content/roster.ts";
import { spadePage, spadeQuestions, tour, turnOn } from "../content/spade.ts";
import {
  agentsSentence,
  bullets,
  count,
  names,
  questions,
  series,
  type Href,
} from "./markdown-blocks.ts";

/*
 * Every page but home and download as Markdown (seo/markdown.ts dispatches). Each opens with one
 * sentence saying what its subject is, with the subject named, then the page's own words.
 */

/* "The open-source agent…" reads on after "OpenCode is"; a name such as "Anthropic's" keeps its capital. */
const lowerFirst = (text: string) => (text.startsWith("The ") ? `t${text.slice(1)}` : text);
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** "Opus 5.5 (Medium effort)", or nothing for an agent with no model listed. */
function modelOf(label: string): string | undefined {
  const entry = currentModels[label];
  if (!entry) return undefined;
  return entry.effort ? `${entry.model} (${entry.effort} effort)` : entry.model;
}

export function featureIndex(href: Href): string[] {
  return [
    "# Features of ace",
    "",
    `> ace's features are what ace adds to every coding agent it runs, whichever CLI runs the agent. ace has ${count(features.length)} features with pages of their own: ${series(features.map((feature) => feature.name))}.`,
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

export function featurePage(slug: string): string[] | undefined {
  const feature = features.find((entry) => entry.slug === slug);
  if (!feature) return undefined;
  return [
    `# ${feature.headline}`,
    "",
    `> ${feature.name} is a feature of ace, the free, open-source app that runs coding agents as one team. ${feature.intro}`,
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

export function agentIndex(href: Href): string[] {
  return [
    "# Coding agents ace runs",
    "",
    `> ${agentsSentence}`,
    "",
    "ace runs each agent through its own logged-in CLI. ace never asks for, stores or proxies provider credentials.",
    "",
    `## ${roster.builtIn.heading}`,
    "",
    roster.builtIn.lede,
    "",
    ...agentGuides.map((guide) => {
      const model = modelOf(guide.label);
      return `- [${guide.label}](${href(`/agents/${guide.slug}/`)}): ${guide.what}${model ? ` Model ace lists first for it (2026-11-18): ${model}.` : ""}`;
    }),
    "",
    `## ${roster.acp.heading}`,
    "",
    roster.acp.lede,
    "",
    `ACP agents ace knows by name: ${names(acpAgents)}, and any other ACP agent.`,
    "",
    `## ${roster.factsHeading}`,
    "",
    ...bullets(rosterFacts.map((fact) => `${fact.title}: ${fact.body}`)),
    "",
  ];
}

export function agentPage(slug: string, href: Href): string[] | undefined {
  const guide = agentGuides.find((entry) => entry.slug === slug);
  if (!guide) return undefined;
  const model = modelOf(guide.label);
  return [
    `# Run ${guide.label} in ace`,
    "",
    `> ${guide.label} is ${lowerFirst(guide.what)} ace, a free, open-source app, runs ${guide.label} through its own signed-in CLI on Mac, Windows and Linux, beside ${series(builtInAgents.filter((agent) => agent.label !== guide.label).map((agent) => agent.label))}.`,
    "",
    ...(model
      ? [`In ace's model picker, ${guide.label}'s first model is ${model}, as of 2026-11-18.`, ""]
      : []),
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

export function mcpPage(): string[] {
  const tools = toolReference.reduce((sum, family) => sum + family.tools.length, 0);
  return [
    "# MCP tools every agent gets in ace",
    "",
    `> ace's MCP tools are ${tools} Model Context Protocol tools in ${toolReference.length} families that ace's MCP server gives every agent session, so ${series(builtInAgents.map((agent) => agent.label))} and every ACP agent get the same tools.`,
    "",
    "Each agent's own CLI and the permission mode you chose decide which tools run. ace adds no approvals of its own.",
    "",
    ...toolReference.flatMap((family) =>
      [`## ${family.family}`, "", sentence(family.purpose), ""].concat(
        family.tools.map((tool) => `- \`${tool.name}\`: ${tool.does}`),
        [""],
      ),
    ),
  ];
}

export function securityPage(): string[] {
  return [
    "# Security and privacy in ace",
    "",
    "> ace is an app you run on your own machines, not a hosted service: agents, threads and code stay on your computers, and provider credentials stay with each agent's own CLI.",
    "",
    ...boundary.flatMap((item) => [`## ${item.title}`, "", item.body, ""]),
    "## Questions",
    "",
    ...questions(securityQuestions),
  ];
}

export function spadeMarkdown(): string[] {
  return [
    `# Spade: ${spadePage.headline}`,
    "",
    `> ${spadePage.intro}`,
    "",
    ...bullets([
      `Spade is ${spadePage.status.toLowerCase()}: it ships in every copy of ace and is off until switched on in ace's Settings › Beta.`,
      "Spade runs as its own service on your computer, beside ace, and is never hosted.",
      "Spade uses your own models: any endpoint with your key, kept in your operating system's keychain, or a coding CLI you are signed in to.",
      "Spade is part of ace, which is free and open source (Apache-2.0).",
    ]),
    "",
    `## ${tour.label}`,
    "",
    `Spade has ${tour.steps.length} features, shown one at a time on the page:`,
    "",
    ...tour.steps.map((step, index) => `${index + 1}. ${step.title}: ${step.body}`),
    "",
    "## How to turn Spade on",
    "",
    ...turnOn.steps.map((step, index) => `${index + 1}. ${step.name}: ${step.body}`),
    "",
    "## Questions",
    "",
    ...questions(spadeQuestions),
  ];
}

export function faqMarkdown(): string[] {
  return [
    "# Questions about ace",
    "",
    "> Answers to common questions about ace, the free, open-source app that runs coding agents such as Claude Code, Codex and Cursor as one team on your own machines.",
    "",
    "## About ace",
    "",
    ...questions(faq),
    ...features.flatMap((feature) =>
      [`## ${feature.name}`, ""].concat(questions(feature.questions)),
    ),
    "## Thread status",
    "",
    "A thread's status in ace covers every subagent and background command it started.",
    "",
    ...statuses.map((status) => `- ${status.word}: ${status.meaning}`),
    "",
  ];
}

const legalBlock = (block: LegalBlock) =>
  typeof block === "string" ? [block, ""] : [...bullets(block.list), ""];

export function legalMarkdown(path: string): string[] | undefined {
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
