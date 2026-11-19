/*
 * The words of /mcp/: ace's MCP tools by group, how each CLI loads them, and the page's
 * questions. Tool names are the real ones (packages/mcp-server, packages/browser,
 * packages/devices, packages/screen and the daemon's machines tools); a renamed or new tool
 * changes here too. seo/markdown.ts reads `toolReference` for the page's Markdown copy.
 */
import type { ProviderKind } from "@ace/protocol";

export interface Tool {
  name: string;
  does: string;
}

export interface ToolFamily {
  family: string;
  purpose: string;
  tools: Tool[];
}

/* Groups in the order an agent meets them, each with one line on what it is for. */
export const toolReference: ToolFamily[] = [
  {
    family: "Agents",
    purpose: "Hand work to other agents and wait for it.",
    tools: [
      {
        name: "delegate",
        does: "Start agents on any provider or linked machine, each in its own thread.",
      },
      { name: "wait", does: "Wait for those agents, or any other thread, to finish." },
      { name: "agents_status", does: "See where each agent it started stands." },
      { name: "agent_message", does: "Send a running agent a follow-up or a correction." },
      { name: "agent_cancel", does: "Stop an agent that is no longer needed." },
      { name: "models", does: "List the models and accounts each provider offers." },
      { name: "data_send", does: "Send a file or text to another agent, end-to-end encrypted." },
      { name: "data_receive", does: "Read what other agents sent and save it into the project." },
      { name: "ask", does: "Ask you a question in ace and wait for the answer." },
    ],
  },
  {
    family: "Browser",
    purpose: "A real browser you can watch and take over.",
    tools: [
      { name: "browser_open", does: "Open a page in ace's browser, or another machine's." },
      { name: "browser_snapshot", does: "Read the page as structured text it can act on." },
      { name: "browser_act", does: "Click, type, scroll and press keys on the page." },
      { name: "browser_find", does: "Find elements by text or role." },
      { name: "browser_screenshot", does: "Capture the page or one element." },
      { name: "browser_logs", does: "Read the console and the network log." },
      { name: "browser_evaluate", does: "Run a script in the page and return its value." },
      { name: "browser_wait_for", does: "Wait for text, an element or the network to settle." },
      { name: "browser_tabs", does: "Open, switch and close tabs." },
      { name: "browser_history", does: "Go back, forward or reload." },
      { name: "browser_measure", does: "Measure how smoothly the page scrolls and animates." },
      { name: "browser_settings", does: "Resize a tab, emulate a phone or record the tab." },
      {
        name: "browser_request_help",
        does: "Ask you to sign in or solve a check, instead of typing a password.",
      },
    ],
  },
  {
    family: "Computer use",
    purpose: "Desktop apps, used in the background.",
    tools: [
      { name: "screen_apps", does: "List running and installed apps." },
      { name: "screen_state", does: "Open an app in the background and read its window." },
      {
        name: "screen_act",
        does: "Click, type and press keys in that app, then see what changed.",
      },
      {
        name: "screen_display",
        does: "Picture whole displays, without the apps agents may not use. Mac only.",
      },
    ],
  },
  {
    family: "Devices",
    purpose: "iOS Simulators, Android emulators and Android phones.",
    tools: [
      { name: "sim_list", does: "List the simulators, emulators and phones on a machine." },
      { name: "sim_start", does: "Take a device for the thread, booting it if needed." },
      { name: "sim_ui", does: "Read the screen as a tree of elements." },
      { name: "sim_act", does: "Tap, type, swipe, open links and install builds." },
      { name: "sim_screenshot", does: "Capture the screen." },
      { name: "sim_logs", does: "Read the device's log." },
      { name: "sim_stop", does: "Hand the device back." },
    ],
  },
  {
    family: "Machines",
    purpose: "Your other computers, as far as each one allows.",
    tools: [
      { name: "machines", does: "List your linked machines and what each one offers." },
      {
        name: "transfer",
        does: "Move a project or this thread to another machine, uncommitted changes included.",
      },
      { name: "command_run", does: "Run a command in a project on another machine." },
      { name: "command_status", does: "Check whether a background command is still running." },
      { name: "command_output", does: "Read a background command's output." },
      { name: "command_stop", does: "Stop a background command and everything it started." },
    ],
  },
  {
    family: "Threads",
    purpose: "The work around it, and the notes that outlive it.",
    tools: [
      {
        name: "context",
        does: "Recent threads, uncommitted changes, pull requests and notes in one read.",
      },
      { name: "thread_start", does: "Start a separate thread in any project." },
      { name: "threads_find", does: "Find threads by text, status or project." },
      { name: "thread_read", does: "Read another thread's work." },
      { name: "thread_fork", does: "Fork a thread to try another approach." },
      { name: "thread_merge", does: "Bring a finished fork's result back." },
      { name: "thread_control", does: "Rename, interrupt, snooze or settle a thread it owns." },
      { name: "queue_edit", does: "Edit, reorder or cancel queued messages." },
      {
        name: "question_answer",
        does: "Answer a question another agent asked. Never an approval.",
      },
      { name: "thread_link_pr", does: "Link a pull request to the thread that wrote it." },
      { name: "handoff_read", does: "Read the history a thread brought from another provider." },
      { name: "projects_find", does: "List this machine's projects." },
      { name: "note_add", does: "Save a project note every later agent reads." },
      { name: "note_retire", does: "Remove a note that no longer holds." },
    ],
  },
  {
    family: "Show",
    purpose: "Answers you can see, and word when you're away.",
    tools: [
      { name: "html_render", does: "Post a chart, diagram or interactive page into the thread." },
      { name: "html_preview", does: "Check that page at phone and desktop width first." },
      { name: "image_show", does: "Post an image into the reply." },
      { name: "notify", does: "Send you a notification." },
    ],
  },
  {
    family: "Automations",
    purpose: "Prompts that run on their own.",
    tools: [
      { name: "automation_put", does: "Create or change an automation." },
      { name: "automation_run", does: "Run, pause or resume one now." },
      { name: "automations_list", does: "List automations and their last runs." },
      { name: "automation_remove", does: "Delete one." },
    ],
  },
  {
    family: "Finding tools",
    purpose: "The rest, loaded only when needed.",
    tools: [
      { name: "tools_find", does: "Find the ace tool for a task, with how to call it." },
      { name: "tools_call", does: "Call a found tool, in CLIs that can't reload their list." },
      { name: "guide", does: "Read ace's how-to for a topic, which brings its tools along." },
      { name: "suit_apply", does: "Preview, keep or undo a new look for ace." },
      { name: "market_read", does: "Search the market for skills, looks and bots." },
      {
        name: "market_publish",
        does: "Draft and publish to the market, with your say on each step.",
      },
    ],
  },
];

/** How many tools the groups above hold, for the page's words. */
export const toolCount = toolReference.reduce((sum, family) => sum + family.tools.length, 0);

export interface CliLoading {
  cli: string;
  /** The provider kind its mark is drawn from (`@ace/ui-core/provider-icons`), if it has one. */
  provider?: ProviderKind;
  how: string;
}

/*
 * How each CLI takes the tools in, as ADR 0086 records it: every one gets the same set, but a
 * CLI with its own tool search keeps most of them out of the context until they are needed.
 */
export const cliLoading: CliLoading[] = [
  {
    cli: "Claude Code",
    provider: "claude",
    how: "A few tools load at the start. The rest wait behind Claude Code's own tool search.",
  },
  {
    cli: "Codex",
    provider: "codex",
    how: "Every tool is listed. On models with tool search, Codex loads each one when it needs it.",
  },
  {
    cli: "Cursor",
    provider: "cursor",
    how: "Every tool, from the start.",
  },
  {
    cli: "OpenCode, Pi and Gemini CLI",
    how: "The core tools at the start. tools_find adds the rest as the agent asks for them.",
  },
  {
    cli: "Antigravity",
    provider: "antigravity",
    how: "Every tool is listed, and the core ones load at the start.",
  },
  {
    cli: "Other ACP agents",
    how: "The core tools, with tools_find and tools_call to reach the rest.",
  },
];

export const mcpPage = {
  title: "MCP tools for every coding agent: ace",
  description:
    "Claude Code, Codex, Cursor and every agent in ace get the same MCP tools: delegation, a real browser, desktop apps, simulators, threads and automations.",
  headline: "The same tools, in every agent",
  intro:
    "ace gives each agent session its own MCP server, so whichever CLI runs the agent, it can hand off work, use a browser, apps and phones, and show you what it found.",
  toolsHeading: "Every tool, by group.",
  cliHeading: "Each CLI loads them its own way.",
  cliLede:
    "The tools are the same everywhere. What differs is how much of the list sits in the agent's context before it needs it.",
  approvals:
    "Your CLI's own permission mode decides what runs. ace adds no approvals and never answers one.",
  questionsHeading: "Questions about the tools.",
} as const;

/** The page's own questions, after the FAQ's entry on the tools. */
export const mcpQuestions: { question: string; answer: string }[] = [
  {
    question: "Does ace add its own approvals to these tools?",
    answer:
      "No. The agent's own CLI decides what runs, in the permission mode you chose for it. ace adds no approval layer and never answers an approval for you.",
  },
  {
    question: "Do the tools reach my other machines?",
    answer:
      "Yes. An agent can delegate to a linked machine, open its browser and drive its simulators and emulators. Using its desktop apps or running commands there stays off until you allow it on that machine.",
  },
  {
    question: "Can MCP apps outside ace use these tools?",
    answer:
      "Yes, with your approval. An outside app signs in to one of your machines, and in ace you choose what it may do, which projects it sees and for how long.",
  },
];
