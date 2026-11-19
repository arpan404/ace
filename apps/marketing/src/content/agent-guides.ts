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
  /** How it gets onto the computer and signed in, for the second setup step. */
  install: { body: string; command?: string };
}

/*
 * Install commands are the ones ace's own Settings offers (`npm install -g` and the package in
 * packages/provider-kit/src/installers/manifest.ts); keep them in step with that table.
 */
const details: Record<string, Omit<AgentGuide, keyof Agent | "slug">> = {
  "Claude Code": {
    what: "Anthropic's coding agent, run from its own CLI.",
    notes: [
      "Subagents and background shells it starts count toward the thread, so it says Waiting until they finish.",
      "Its permission prompts show as Approve, on your desktop and your phone.",
    ],
    install: {
      body: "Press Install in ace's Settings, or run the command. Then run `claude` once and sign in.",
      command: "npm install -g @anthropic-ai/claude-code",
    },
  },
  Codex: {
    what: "OpenAI's coding agent, run from its own CLI.",
    notes: [
      "Sign in to more than one Codex account and pick one per thread.",
      "Its approvals and questions show as Approve and Answer, on your desktop and your phone.",
    ],
    install: {
      body: "Press Install in ace's Settings, or run the command. Then sign in with `codex login`.",
      command: "npm install -g @openai/codex",
    },
  },
  Cursor: {
    what: "Cursor's coding agent, run through Cursor's own SDK.",
    notes: ["Run it beside Claude Code and Codex, each thread in its own worktree."],
    install: {
      body: "Nothing to install: Cursor's SDK ships with ace. Press Sign in under Cursor in Settings and finish in your browser.",
    },
  },
  OpenCode: {
    what: "The open-source coding agent that works with many model providers.",
    notes: ["It keeps its own providers and models; ace uses them as you set them up."],
    install: {
      body: "Press Install in ace's Settings, or run the command. Then connect a model provider in OpenCode.",
      command: "npm install -g @opencode/cli",
    },
  },
  Antigravity: {
    what: "Google's Antigravity coding agent.",
    notes: ["Sign in to more than one Antigravity account and pick one per thread."],
    install: {
      body: "Press Install in ace's Settings: ace fetches it from the ACP registry. Then sign in with a Google account or Gemini Enterprise.",
    },
  },
  Pi: {
    what: "The Pi coding agent, run from its own CLI.",
    notes: ["It keeps its own model registry; ace uses the models you set up there."],
    install: {
      body: "Press Install in ace's Settings, or run the command. Then sign in or add a key in Pi.",
      command: "npm install -g @earendil-works/pi-coding-agent",
    },
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
    install: detail.install,
  };
});

export function agentGuide(slug: string): AgentGuide {
  const found = agentGuides.find((guide) => guide.slug === slug);
  if (!found) throw new Error(`No agent guide called ${slug}`);
  return found;
}

/** One setup step: a short title, a sentence, and the command to run when there is one. */
export interface SetupStep {
  title: string;
  body: string;
  command?: string;
}

/** How to run an agent in ace, in three steps, for its page. */
export function agentSteps(guide: AgentGuide): SetupStep[] {
  const name = guide.label;
  return [
    {
      title: "Download ace",
      body: "Install it on your Mac, Windows or Linux computer and open a project folder.",
    },
    { title: `Install ${name} and sign in`, ...guide.install },
    {
      title: `Start a thread with ${name}`,
      body: `Pick ${name} in the composer's model picker and send. Give the thread its own worktree when other agents share the repository.`,
    },
  ];
}

/** The same steps as plain sentences, for the page's Markdown. */
export function agentSetup(guide: AgentGuide): string[] {
  return agentSteps(guide).map((step) =>
    [`${step.title}.`, step.body, step.command && `Command: \`${step.command}\``]
      .filter(Boolean)
      .join(" "),
  );
}

/** The questions an agent's page answers, for its page, its structured data and its Markdown. */
export function agentQuestions(guide: AgentGuide): { question: string; answer: string }[] {
  const name = guide.label;
  const others = agentGuides
    .filter((other) => other.slug !== guide.slug)
    .slice(0, 3)
    .map((other) => other.label)
    .join(", ");
  return [
    {
      question: `Does ace need a ${name} API key?`,
      answer: `No. ace runs ${name} on its own login, the one you already use, so your plan keeps working. ace never asks for, stores or proxies credentials.`,
    },
    {
      question: `Can I run ${name} beside other agents?`,
      answer: `Yes. Run ${name} beside ${others} and the rest, each thread in its own git worktree, and hand a thread from one agent to another with its context.`,
    },
    {
      question: `Can ${name} hand work to other agents?`,
      answer: `Yes. With ace's delegate tool, ${name} starts agents on other providers and your other machines, then waits for their results.`,
    },
    {
      question: `Can ${name} use a browser and my desktop apps in ace?`,
      answer: `Yes. ${name} gets the same MCP tools as every agent in ace: a real browser, your desktop apps, phone simulators and agents on your other machines.`,
    },
  ];
}
