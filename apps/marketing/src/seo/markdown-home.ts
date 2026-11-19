import { acpAgents, builtInAgents } from "../content/agents.ts";
import {
  downloadPage,
  phoneNotes,
  platformGuides,
  type PlatformGuide,
} from "../content/download.ts";
import { partGroups, type Part } from "../content/parts.ts";
import { boundary, product, spade, statuses } from "../content/product.ts";
import type { Downloads } from "../content/release-download.ts";
import { chipName, platforms, type Platform } from "../content/release-pick.ts";
import { showcase } from "../content/showcase.ts";
import { captionWith, zoomCaptions } from "../content/zoom.ts";
import { links } from "../site.ts";
import {
  aceDefinition,
  agentsSentence,
  bullets,
  downloadLines,
  isAndIsNot,
  names,
  releaseFileLines,
  versionFacts,
  type Href,
} from "./markdown-blocks.ts";

/* The home and download pages as Markdown: the two an assistant is most often asked about. */

/** One part of ace as a list line: its name (linked when it has a page), then what it does. */
function partLine(part: Part, href: Href): string {
  const name = part.href ? `[${part.name}](${href(part.href)})` : part.name;
  return `${name}${part.beta ? " (beta)" : ""}: ${part.body}`;
}

/** Each desktop system with the chips this release has builds for, when the release is known. */
function desktopPlatforms(downloads: Downloads): string {
  const systems: Record<Platform, string> = {
    mac: "macOS",
    windows: "Windows 10 and 11",
    linux: "Linux (Ubuntu 24.04 or newer, Fedora, Debian 12 or newer and Omarchy, on Wayland)",
  };
  return platforms
    .map((platform) => {
      const chips = [...new Set(downloads.files[platform].map((file) => file.arch))];
      const built = chips.map((arch) => chipName[platform][arch]).join(" and ");
      return built ? `${systems[platform]} on ${built}` : systems[platform];
    })
    .join("; ");
}

/** The short list of facts the home and download pages both open with. */
function facts(downloads: Downloads): string[] {
  return [
    "## Facts",
    "",
    ...bullets([
      "Name: ace",
      "What it is: a desktop app that runs coding agents as one team, with companion apps for iPhone and iPad",
      "Price: free",
      "License: Apache-2.0, open source",
      `Desktop platforms: ${desktopPlatforms(downloads)}`,
      "Mobile: ace for iPhone and iPad; Android coming soon",
      `Built-in agents: ${names(builtInAgents)}`,
      `Other agents: any Agent Client Protocol (ACP) agent, such as ${names(acpAgents)}`,
      "Credentials: ace never asks for, stores or proxies provider credentials",
      "Hosting: none; ace runs on your own computers",
      ...(downloads.version ? [`Current version: ${downloads.version}`] : []),
      `Source code: ${links.source}`,
    ]),
    "",
  ];
}

export function homeMarkdown(href: Href, downloads: Downloads): string[] {
  return [
    `# ${product.name}: ${product.headline}`,
    "",
    `> ${aceDefinition}`,
    "",
    product.summary,
    "",
    product.about,
    "",
    ...facts(downloads),
    "## Key facts",
    "",
    ...bullets(product.facts),
    ...versionFacts(downloads).map((fact) => `- ${fact}`),
    "",
    "## How it works",
    "",
    ...zoomCaptions.flatMap((caption) => [
      `### ${caption.title}`,
      "",
      captionWith(caption.body, builtInAgents[0]?.label ?? "An agent"),
      "",
      `More: ${href(caption.href)}`,
      "",
    ]),
    "## The agents ace runs",
    "",
    agentsSentence,
    "Each agent signs in through its own CLI, on the subscription you already pay for.",
    "",
    `## ${showcase.heading}`,
    "",
    showcase.lede,
    "",
    ...bullets(
      showcase.tiles.map((tile) =>
        tile.href
          ? `[${tile.title}](${href(tile.href)}): ${tile.body}`
          : `${tile.title}: ${tile.body}`,
      ),
    ),
    "",
    "## Every part of ace",
    "",
    ...partGroups.flatMap((group) =>
      [`### ${group.name}: ${group.line}`, ""].concat(
        bullets(group.parts.map((part) => partLine(part, href))),
        "",
      ),
    ),
    "## Your machines, your logins, your code",
    "",
    ...bullets(boundary.map((item) => `${item.title}: ${item.body}`)),
    "",
    `## ${spade.name} (${spade.status.toLowerCase()})`,
    "",
    `${spade.body} More: ${href("/spade/")}`,
    "",
    "## Thread status",
    "",
    "A thread's status in ace covers every subagent and background command it started.",
    "",
    ...bullets(statuses.map((status) => `${status.word}: ${status.meaning}`)),
    "",
    ...isAndIsNot(),
    "## Get ace",
    "",
    ...downloadLines(downloads),
    `- [Every download option](${href("/download/")})`,
    `- [Source code on GitHub](${links.source}): Apache-2.0`,
    "",
  ];
}

/** One platform's install section: what it's for, its kinds of build or app notes, three steps. */
function installLines(guide: PlatformGuide): string[] {
  const kinds = guide.kinds ? bullets(guide.kinds.map((kind) => kind.format)).concat("") : [];
  const notes = guide.notes
    ? bullets(guide.notes.map((note) => `${note.name}: ${note.body}`)).concat("")
    : [];
  const steps = guide.steps.map((step, index) => `${index + 1}. ${step}`);
  return [
    `### ${guide.tab}`,
    "",
    guide.id === "phone" ? guide.line : `ace for ${guide.tab}: ${guide.line}`,
    "",
  ].concat(kinds, notes, steps, [""]);
}

export function downloadMarkdown(href: Href, downloads: Downloads): string[] {
  const files = releaseFileLines(downloads);
  return [
    "# Download ace",
    "",
    "> ace is free to download for macOS, Windows and Linux, with apps for iPhone and iPad that follow and steer the agents on your computers.",
    "",
    downloadPage.intro,
    "",
    ...versionFacts(downloads),
    "",
    downloadPage.before,
    "",
    ...facts(downloads),
    "## Downloads",
    "",
    ...downloadLines(downloads),
    `- [Release notes](${downloads.notesUrl})`,
    `- [All releases](${links.releases})`,
    "",
    ...(files.length ? ["## Every build in this release", "", ...files, ""] : []),
    "## Install, by platform",
    "",
    ...platformGuides.flatMap(installLines),
    phoneNotes.android,
    "",
    downloadPage.updates,
    "",
    `More about the iPhone and iPad apps: ${href(phoneNotes.more.href)}`,
    "",
  ];
}
