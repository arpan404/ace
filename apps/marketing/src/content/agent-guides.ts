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

/** How to run an agent in ace, step by step, for its page and its Markdown. */
export function agentSetup(guide: AgentGuide): string[] {
  const name = guide.label;
  return [
    `Install ${name} and sign in, the way its own instructions say. ace uses that login as it is.`,
    "Download ace for your computer and open a project folder.",
    `Start a thread and choose ${name}. Give it its own worktree if other agents share the repository.`,
  ];
}

/** The questions an agent's page answers, for its page, its structured data and its Markdown. */
export function agentQuestions(guide: AgentGuide): { question: string; answer: string }[] {
  const name = guide.label;
  return [
    {
      question: `Does ace need a ${name} API key?`,
      answer: `No. ace starts ${name} through its own command-line tool, signed in the way you already use it, so your existing plan keeps working. ace never asks for, stores or proxies credentials.`,
    },
    {
      question: `Can I run ${name} beside other agents?`,
      answer: `Yes. Run ${name}, Claude Code, Codex, Cursor and others side by side, each thread in its own git worktree, and hand a thread from one agent to another with its context.`,
    },
    {
      question: `Can ${name} hand work to other agents?`,
      answer: `Yes. ${name} can delegate tasks to agents on other providers and on your other machines with ace's delegate tool, and wait for their results.`,
    },
    {
      question: `Can ${name} use a browser and my desktop apps in ace?`,
      answer: `Yes. ace gives ${name} the same MCP tools as every other agent: a real browser, computer use, phone simulators, and delegating to agents on other machines.`,
    },
  ];
}
