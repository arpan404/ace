/*
 * What the site says about ace, in one place. The page, its structured data and llms.txt all
 * read from here, so a search engine, an AI assistant and a person see the same facts.
 */

export const product = {
  name: "ace",
  title: "ace: Claude Code, Codex and Cursor agents in one window",
  headline: "All your coding agents, one window.",
  summary:
    "ace drives Claude Code, Codex, Cursor and the other CLIs you already use, and tells you which one needs you.",
  /** For search results: at most about 160 characters. */
  description:
    "ace is a free, open-source Mac app that runs Claude Code, Codex, Cursor and other coding agents side by side, with browser use, computer use and simulators.",
  /** The fuller paragraph for structured data and llms.txt. */
  about:
    "ace is a free, open-source Mac app for running coding agents. It drives the agent CLIs you already have logged in (Claude Code, Codex, Cursor, OpenCode, Antigravity, Pi and any ACP agent) and shows which thread is working, waiting or needs you. Agents get one MCP toolset in every CLI: they can delegate to other agents, use a real browser, operate Mac apps through computer use, and test on iOS Simulators and Android emulators from the devices hub. Fleet links your machines and pairs your phone, and each thread can work in its own git worktree with a built-in diff review.",
  category: "DeveloperApplication",
  operatingSystem: "macOS",
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

/** What else ace does, beyond the sections that have their own space on the page. */
export const features: { icon: FeatureIcon; title: string; body: string }[] = [
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

export type CapabilityIcon = "browser" | "cursor-click" | "device-mobile";

/** What agents can operate besides code, each through ace's own tools. */
export const capabilities: {
  icon: CapabilityIcon;
  title: string;
  body: string;
  details: string[];
  tools: string[];
}[] = [
  {
    icon: "browser",
    title: "Browser use",
    body: "Agents open your dev server in ace's browser, click through it and read the console and network log. You watch the same tab and can take over at any moment.",
    details: [
      "Several tabs per agent, Chrome extensions included",
      "Mark up a page and send the notes to the agent",
      "Optionally let agents use your own Chrome and its logins",
    ],
    tools: ["browser_open", "browser_snapshot", "browser_act", "browser_logs"],
  },
  {
    icon: "cursor-click",
    title: "Computer use",
    body: "Agents work in your Mac's apps in the background, without taking your mouse or keyboard. Each session shows who is in control, with Take over and Stop beside it.",
    details: [
      "Reads apps through accessibility, then clicks and types",
      "One switch turns it on; you choose apps agents can't use",
      "Live view of every app an agent is driving",
    ],
    tools: ["screen_apps", "screen_state", "screen_act"],
  },
  {
    icon: "device-mobile",
    title: "Devices hub",
    body: "Run iOS Simulators and Android emulators inside ace. Tap, type and rotate them yourself, or hand a device to an agent to test your app.",
    details: [
      "Live screen, UI tree, logs and recordings",
      "Approve a device before an agent can use it",
      "Delegate a device to any agent in the thread",
    ],
    tools: ["sim_list", "sim_start", "sim_ui", "sim_act"],
  },
];

/** What a fleet gives you, beside the Fleet settings screenshot. */
export const fleetPoints: { title: string; body: string }[] = [
  {
    title: "Link machines",
    body: "Agents on your laptop can start threads and open browsers on your build server, and every thread shows in one list.",
  },
  {
    title: "Pair devices",
    body: "Pair a phone, tablet or browser with a link or QR code. Choose view only or view and act, and how long access lasts.",
  },
  {
    title: "Reach them anywhere",
    body: "Connect over your local network, Tailscale, or an end-to-end encrypted relay you can host yourself.",
  },
];

/** ace's MCP tools, grouped as agents find them. Every provider gets the same set. */
export const toolFamilies: { family: string; purpose: string; tools: string[] }[] = [
  {
    family: "Agents",
    purpose: "Start agents on any provider or machine and wait for them",
    tools: ["delegate", "wait", "agents_status", "agent_message"],
  },
  {
    family: "Browser",
    purpose: "Open, read and drive pages you can watch",
    tools: ["browser_open", "browser_snapshot", "browser_act", "browser_logs"],
  },
  {
    family: "Computer",
    purpose: "Use Mac apps in the background",
    tools: ["screen_apps", "screen_state", "screen_act"],
  },
  {
    family: "Devices",
    purpose: "Drive iOS Simulators and Android emulators",
    tools: ["sim_list", "sim_start", "sim_ui", "sim_act"],
  },
  {
    family: "Threads",
    purpose: "Find work, start threads and keep project notes",
    tools: ["context", "thread_start", "threads_find", "note_add"],
  },
  {
    family: "Show",
    purpose: "Put pages, images and alerts in front of you",
    tools: ["html_render", "image_show", "notify"],
  },
  {
    family: "Automations",
    purpose: "Schedule prompts and run them on demand",
    tools: ["automation_put", "automation_run"],
  },
];

/** Questions people ask before trying ace. Shown on the page and published as FAQPage data. */
export const faq: { question: string; answer: string }[] = [
  {
    question: "What is ace?",
    answer:
      "ace is a desktop app for running coding agents. It starts the agent CLIs you already have installed, such as Claude Code, Codex and Cursor, gives each task its own thread, optionally in its own git worktree, and shows which threads are working, waiting or need you.",
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
    question: "Can agents use a browser, my Mac's apps or a phone simulator?",
    answer:
      "Yes. Agents drive ace's built-in browser, use Mac apps in the background through computer use, and run iOS Simulators and Android emulators from the devices hub. You watch each one live and can take over or stop it.",
  },
  {
    question: "What are ace's MCP tools?",
    answer:
      "ace runs an MCP server for every agent session, so Claude Code, Codex, Cursor and the others all get the same tools: start and wait on other agents, drive the browser, apps and simulators, show pages and images in the thread, and schedule automations. Your CLI's own permission mode decides what runs.",
  },
  {
    question: "What is Fleet?",
    answer:
      "Fleet links your machines and devices. Linked machines let agents start threads and use browsers on each other, and paired phones, tablets and browsers can follow and steer agents. Machines connect over your local network, Tailscale, or an end-to-end encrypted relay.",
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
    question: "Which Macs does ace run on?",
    answer:
      "ace runs on macOS with Apple silicon. Download the disk image, open it and drag ace to Applications. The app checks for new releases and updates itself.",
  },
  {
    question: "Is ace free?",
    answer:
      "Yes. ace is open source under the Apache-2.0 license. You pay only for the agent subscriptions you already have.",
  },
];
