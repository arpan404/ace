import { builtInAgents, type Agent } from "./agents.ts";

/*
 * A page per built-in agent (/agents/<slug>/): what ace adds to that agent's own CLI. The agent
 * list itself comes from agents.ts (the app's table), so a page exists only for an agent ace runs.
 */

export interface AgentGuide extends Agent {
  slug: string;
  /** One line on what the agent is, in neutral terms. */
  what: string;
  /** What is particular about running this agent in ace, beyond what every agent gets. */
  notes: string[];
}

const details: Record<string, { what: string; notes: string[] }> = {
  "Claude Code": {
    what: "Anthropic's coding agent, run from its own command-line tool.",
    notes: [
      "Subagents and background shells Claude Code starts count toward the thread's status, so the thread says Waiting until they finish.",
      "Permission prompts show as Approve in the thread, on your desktop and on your phone.",
    ],
  },
  Codex: {
    what: "OpenAI's coding agent, run from its own command-line tool.",
    notes: [
      "Sign in to more than one Codex account and choose which one a thread runs on.",
      "Approvals and questions show as Approve and Answer, on your desktop and on your phone.",
    ],
  },
  Cursor: {
    what: "Cursor's coding agent, run from its command-line tool.",
    notes: ["Run Cursor's agent beside Claude Code and Codex, each thread in its own worktree."],
  },
  OpenCode: {
    what: "The open-source coding agent that works with many model providers.",
    notes: [
      "OpenCode keeps its own provider and model configuration; ace uses it as you set it up.",
    ],
  },
  Antigravity: {
    what: "Google's Antigravity coding agent.",
    notes: ["Sign in to more than one Antigravity account and choose one per thread."],
  },
  Pi: {
    what: "The Pi coding agent, run from its own command-line tool.",
    notes: ["Pi keeps its own model registry; ace uses the models you set up there."],
  },
};

const slugOf = (label: string) => label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

export const agentGuides: AgentGuide[] = builtInAgents.map((agent) => {
  const detail = details[agent.label];
  if (!detail) throw new Error(`Write an agent guide for ${agent.label}`);
  return {
    brand: agent.brand,
    label: agent.label,
    slug: slugOf(agent.label),
    what: detail.what,
    notes: detail.notes,
  };
});

export function agentGuide(slug: string): AgentGuide {
  const found = agentGuides.find((guide) => guide.slug === slug);
  if (!found) throw new Error(`No agent guide called ${slug}`);
  return found;
}
