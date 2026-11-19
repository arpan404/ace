import type { AgentGuide } from "../content/agent-guides.ts";
import { downloadPage } from "../content/download.ts";
import { features } from "../content/features.ts";
import { legalDocuments } from "../content/legal.ts";
import { spadePage } from "../content/spade.ts";

/*
 * Each page's <title> and meta description, for the pages whose words aren't in a content file
 * of their own, and one lookup over every page for the tests that hold them to search engines'
 * limits: a title of at most 60 characters that says what the page is and ends with "ace", and a
 * description of at most 155 that says what the visitor gets.
 *
 * The MCP, security and FAQ pages write theirs in their own page files, so they are not here.
 */

export interface Meta {
  title: string;
  description: string;
}

export const homeMeta: Meta = {
  title: "Run Claude Code, Codex and Cursor as one team: ace",
  description:
    "ace is a free, open-source app where Claude Code, Codex and Cursor work as one team across your Mac, Windows and Linux machines, with phone apps.",
};

export const featuresMeta: Meta = {
  title: "Features: computer use, multi-machine agents and more: ace",
  description:
    "What ace adds to Claude Code, Codex, Cursor and every agent you run: computer use, Fleet across machines, a real browser, simulators, worktrees and review.",
};

export const agentsMeta: Meta = {
  title: "Supported agents: Claude Code, Codex, Cursor and ACP: ace",
  description:
    "ace runs Claude Code, Codex, Cursor, OpenCode, Antigravity, Pi and any Agent Client Protocol agent side by side, through the CLIs you already have.",
};

export function agentMeta(guide: Pick<AgentGuide, "label">): Meta {
  const name = guide.label;
  return {
    title: `Run ${name} in a desktop and phone app: ace`,
    description: `Run ${name} with ace on Mac, Windows or Linux: a worktree per task, status you can trust, computer use, a browser and approvals from your phone.`,
  };
}

/** Every page's meta whose words this module or a content file holds, by path. */
export function knownMeta(agents: Pick<AgentGuide, "label" | "slug">[]): Record<string, Meta> {
  return {
    "/": homeMeta,
    "/features/": featuresMeta,
    "/agents/": agentsMeta,
    "/download/": downloadPage,
    "/spade/": spadePage,
    ...Object.fromEntries(
      features.map((feature) => [`/features/${feature.slug}/`, feature] as const),
    ),
    ...Object.fromEntries(agents.map((guide) => [`/agents/${guide.slug}/`, agentMeta(guide)])),
    ...Object.fromEntries(legalDocuments.map((document) => [document.path, document] as const)),
  };
}
