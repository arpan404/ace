/*
 * What the site says about ace, in one place. The page, its structured data and llms.txt all
 * read from here, so a search engine, an AI assistant and a person see the same facts.
 */

export const product = {
  name: "ace",
  title: "ace: one app for Claude Code, Codex, Cursor and every agent",
  headline: "All your coding agents, one window.",
  summary:
    "ace drives Claude Code, Codex, Cursor and the CLIs you already use, across all your machines, and tells you which one needs you.",
  /** For search results: at most about 160 characters. */
  description:
    "ace is a free, open-source app for Mac, Windows and Linux that runs Claude Code, Codex and Cursor side by side, with computer use and phone apps.",
  /** The fuller paragraph for structured data and llms.txt. */
  about:
    "ace is a free, open-source app for running coding agents on Mac, Windows and Linux, with ace for iPhone, iPad and Android to follow and steer them. It drives the agent CLIs you already have logged in (Claude Code, Codex, Cursor, OpenCode, Antigravity, Pi and any ACP agent) and shows which thread is working, waiting or needs you. Agents get one MCP toolset in every CLI: they can delegate to other agents, use a real browser, operate desktop apps through computer use, and test on iOS Simulators and Android emulators from the devices hub. Fleet links your machines so agents on one can start threads and use browsers, simulators and emulators on another, and pairs your phones and tablets. Each thread can work in its own git worktree with a built-in diff review.",
  category: "DeveloperApplication",
  operatingSystem: "macOS, Windows, Linux, iOS, iPadOS, Android",
  license: "Apache-2.0",
} as const;

export type StatusTone = "working" | "needs-you" | "waiting" | "failed" | "done";

/** The app's own status words, each with what it means for the thread. */
export const statuses: { tone: StatusTone; word: string; meaning: string }[] = [
  { tone: "working", word: "Working", meaning: "The agent, or one of its subagents, is running." },
  {
    tone: "needs-you",
    word: "Approve",
    meaning: "It is stopped on a permission or a question for you.",
  },
  {
    tone: "waiting",
    word: "Waiting",
    meaning: "Its turn ended, but subagents or commands still run.",
  },
  { tone: "failed", word: "Failed", meaning: "It stopped on an error you should read." },
  { tone: "done", word: "Done", meaning: "Every agent and command in the thread has finished." },
];

export type FeatureIcon =
  | "lock"
  | "tree-structure"
  | "git-pull-request"
  | "clock-countdown"
  | "chart-bar"
  | "terminal-window";

/** What else ace does, beyond the features with pages of their own. */
export const workbench: { icon: FeatureIcon; title: string; body: string }[] = [
  {
    icon: "lock",
    title: "Runs on your machine",
    body: "A small daemon lives next to your code. It owns the agent processes, terminals and worktrees. Provider credentials never pass through it.",
  },
  {
    icon: "tree-structure",
    title: "Hand off between models",
    body: "Move a thread from Claude to Codex with its context, or send one task to several agents and keep the best result.",
  },
  {
    icon: "git-pull-request",
    title: "Pull requests and issues",
    body: "Open them as full pages, link them to the thread that wrote the code, and merge once checks pass.",
  },
  {
    icon: "clock-countdown",
    title: "Automations",
    body: "Run a prompt on a schedule, like a nightly flaky-test sweep. Each run gets its own thread to read in the morning.",
  },
  {
    icon: "chart-bar",
    title: "Answers you can see",
    body: "Agents post charts, diagrams and interactive pages straight into the thread, and they replay with it later.",
  },
  {
    icon: "terminal-window",
    title: "Terminals in every thread",
    body: "Open a shell in the thread's worktree, watch the commands an agent left running, and stop them from the composer.",
  },
];

/** Questions people ask before trying ace. Shown on the page and published as FAQPage data. */
export const faq: { question: string; answer: string }[] = [
  {
    question: "What is ace?",
    answer:
      "ace is an app for running coding agents on Mac, Windows and Linux, with companion apps for iPhone, iPad and Android. It starts the agent CLIs you already have installed, such as Claude Code, Codex and Cursor, gives each task its own thread, optionally in its own git worktree, and shows which threads are working, waiting or need you.",
  },
  {
    question: "Does ace need my API keys or a new subscription?",
    answer:
      "No. ace runs each agent through its own logged-in CLI, so your existing subscriptions and logins keep working. ace never asks for, stores or proxies provider credentials.",
  },
  {
    question: "Which coding agents does ace support?",
    answer:
      "Claude Code, Codex, Cursor, OpenCode, Antigravity and Pi are built in. Any agent that speaks the Agent Client Protocol (ACP) also works, including Gemini CLI, GitHub Copilot, goose, Amp and Qwen Code.",
  },
  {
    question: "Can agents use a browser, my computer's apps or a phone simulator?",
    answer:
      "Yes. Agents drive ace's built-in browser, use desktop apps in the background through computer use, and run iOS Simulators and Android emulators from the devices hub. You watch each one live and can take over or stop it.",
  },
  {
    question: "What are ace's MCP tools?",
    answer:
      "ace runs an MCP server for every agent session, so Claude Code, Codex, Cursor and the others all get the same tools: start and wait on other agents, drive the browser, apps and simulators, show pages and images in the thread, and schedule automations. Your CLI's own permission mode decides what runs.",
  },
  {
    question: "What is Fleet?",
    answer:
      "Fleet links your machines and devices. Linked machines let agents start threads and use each other's browsers, simulators and emulators, and paired devices (ace for iPhone, iPad and Android, or a browser) can follow and steer agents. Machines connect over your local network, Tailscale, or an end-to-end encrypted relay.",
  },
  {
    question: "Where does my code go?",
    answer:
      "ace runs on your own machine and is never hosted. Your code goes only where your agent CLI already sends it. When you pair another device, it connects through an end-to-end encrypted relay that you can host yourself.",
  },
  {
    question: "Can I run several agents on the same repository?",
    answer:
      "Yes. Start each thread in its own git worktree and the agents never overwrite each other's files. You review each thread's diff, comment on lines, and commit and push from the same panel.",
  },
  {
    question: "Which platforms does ace run on?",
    answer:
      "The desktop app runs on macOS, Windows and Linux and updates itself. ace for iPhone, iPad and Android pairs with your machines so you can follow, approve and steer agents from anywhere; the agents themselves run on your computers.",
  },
  {
    question: "Is ace free?",
    answer:
      "Yes. ace is open source under the Apache-2.0 license. You pay only for the agent subscriptions you already have.",
  },
];

export type BoundaryIcon = "hard-drives" | "key" | "users-three" | "code";

/** Where ace stops: what it holds, what it never touches. */
export const boundary: { icon: BoundaryIcon; title: string; body: string }[] = [
  {
    icon: "hard-drives",
    title: "Your work stays on your machine",
    body: "Threads, history and settings live in a local daemon next to your code. ace is an app you run, never a hosted service.",
  },
  {
    icon: "key",
    title: "Credentials stay with each CLI",
    body: "Every agent runs through its own logged-in CLI and talks to its own provider. ace never asks for, stores or proxies a key.",
  },
  {
    icon: "users-three",
    title: "Remote access is yours to grant",
    body: "Machines and phones join only when you pair them, over your network, Tailscale or an end-to-end encrypted relay you can host.",
  },
  {
    icon: "code",
    title: "Every line is open",
    body: "ace is Apache-2.0. Read the daemon, the clients and the architecture decisions behind them on GitHub.",
  },
];
