import { acpAgents, builtInAgents } from "../content/agents.ts";
import { product } from "../content/product.ts";
import type { Downloads } from "../content/release-download.ts";
import {
  buildText,
  defaultArch,
  formatSize,
  platformInfo,
  platforms,
} from "../content/release-pick.ts";

/*
 * The pieces every page's Markdown is built from (seo/markdown.ts): lists, questions, the
 * download lines and the sentences that say what ace is. Each sentence names its subject, so
 * an assistant that quotes one line alone still quotes something true.
 */

/** Turns a site path into an absolute URL once the site's address is known. */
export type Href = (path: string) => string;

export const names = (list: { label: string }[]) => list.map((agent) => agent.label).join(", ");

/** "A, B and C" */
export const series = (items: readonly string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const counts = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
/** A small count in words, as the site writes it: "six". */
export const count = (n: number) => counts[n] ?? String(n);

/* ACP agents the site names first, when the app's table has them: the best known. */
const knownAcp = new Set(["Gemini CLI", "GitHub Copilot", "goose", "Amp", "Qwen Code"]);
const acpExamples = [
  ...acpAgents.filter((agent) => knownAcp.has(agent.label)),
  ...acpAgents.filter((agent) => !knownAcp.has(agent.label)),
]
  .slice(0, 5)
  .map((agent) => agent.label);
export const bullets = (items: readonly string[]) => items.map((item) => `- ${item}`);
export const questions = (entries: readonly { question: string; answer: string }[]) =>
  entries.flatMap((entry) => [`### ${entry.question}`, "", entry.answer, ""]);

/** The one sentence that opens the site's own description of ace. */
export const aceDefinition = `${product.name} is a free, open-source (Apache-2.0) desktop app that runs coding agents such as ${series(builtInAgents.slice(0, 3).map((agent) => agent.label))} as one team on your own Mac, Windows and Linux machines, with apps for iPhone and iPad to follow and steer them.`;

/** Which agents ace runs, as one standalone sentence. */
export const agentsSentence = `ace runs ${count(builtInAgents.length)} coding agents built in (${series(builtInAgents.map((agent) => agent.label))}) and any agent that speaks the Agent Client Protocol (ACP), such as ${series(acpExamples)}.`;

/** What ace is and what it never does, drawn from content/product.ts and ADR 0002. */
export function isAndIsNot(): string[] {
  return [
    "## What ace is and is not",
    "",
    "ace is:",
    "",
    ...bullets([
      "A desktop app and a small local daemon that run on your own computers, next to your code.",
      "A way to run many coding-agent threads at once, each optionally in its own git worktree, with a status that counts every subagent and background command.",
      "A shared set of MCP tools that every agent gets, whichever CLI runs it: delegation to other agents and machines, a real browser, computer use, iOS Simulators and Android emulators, and automations.",
      "Free and open source under the Apache-2.0 license, with apps for iPhone and iPad that pair with your computers.",
    ]),
    "",
    "ace is not:",
    "",
    ...bullets([
      "Not a hosted service: ace has no hosted mode, and your agents and code never run on ace's servers. The optional ace account and its relay only connect your own devices to your own machines, end-to-end encrypted.",
      "Not a model provider or a new subscription: ace drives the agent CLIs you already installed and signed in to, on the plans you already pay for.",
      "Not a credential store for agent providers: ace never asks for, stores or proxies provider credentials; each agent signs in through its own CLI. (Spade, ace's optional assistant in beta, keeps the API keys of endpoints you add for it in your operating system's keychain and nowhere else.)",
      "Not an approval layer: each agent's own CLI and the permission mode you chose decide what runs, and ace never answers an approval for you.",
    ]),
    "",
  ];
}

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

/** Every file the release has, per platform, or nothing when the release couldn't be read. */
export function releaseFileLines(downloads: Downloads): string[] {
  return platforms.flatMap((platform) =>
    downloads.files[platform].map(
      (file) =>
        `- ${platformInfo[platform].name}, ${file.kind}: [${buildText(platform, file.arch, file.bytes)}](${file.url})`,
    ),
  );
}

/** The release's version and date as plain sentences, when the release is known. */
export function versionFacts(downloads: Downloads): string[] {
  if (!downloads.version) return [];
  const date = downloads.publishedAt?.slice(0, 10);
  return [
    `The current version of ace is ${downloads.version}${date ? `, released on ${date}` : ""}.`,
  ];
}
