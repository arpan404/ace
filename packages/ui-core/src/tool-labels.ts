import type { Interaction } from "@ace/protocol";
import { approvalOutcome, type ApprovalOutcome } from "./approvals.ts";
import { middleTruncate } from "./step-display.ts";

/*
 * Tool steps named for what they did (A4): ace's own tools by their action and key argument,
 * computer use as "the computer", other MCP servers as "server › tool". Pure.
 */

/** "browser_open" → "browser open". */
export function humanize(name: string): string {
  return name
    .replace(/^mcp__/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A failure's one-line reason for a row's note (A4): its first line, without a provider tag's
 * JSON payload ("[claude-code:unrecognized_model] {…}" reads "unrecognized model"). The whole
 * error, in words, is in the step's detail.
 */
export function errorNote(error: string | undefined, max = 60): string | undefined {
  const line = error
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  const tagged = /^\[[\w-]+:([\w.-]+)\]\s*(.*)$/.exec(line);
  const text = tagged ? tagged[2]!.replace(/^[{[].*$/, "").trim() || humanize(tagged[1]!) : line;
  const note = text[0]!.toUpperCase() + text.slice(1);
  return note.length > max ? `${note.slice(0, max - 1)}…` : note;
}

const approvalTools: Record<string, string> = {
  shell: "Command",
  bash: "Command",
  "item/commandexecution/requestapproval": "Command",
  execcommandapproval: "Command",
  "item/filechange/requestapproval": "File change",
  applypatchapproval: "File change",
  edit: "File change",
  write: "File change",
  multiedit: "File change",
  notebookedit: "File change",
  "codex-permissions-escalation": "Permission escalation",
  screen_request_app: "App access",
  screen_request_foreground: "Foreground control",
  "browser.evaluate": "Page script",
  "browser.downloads": "Download",
  "browser.upload": "File upload",
  read: "Read file",
  webfetch: "Web request",
  websearch: "Web search",
};

/**
 * The name of the tool an approval is for (IR-2). Never a raw JSON-RPC method or
 * "Unknown tool": MCP tools read "server · tool", anything unknown reads "Action".
 */
export function toolDisplayName(tool: string | undefined): string {
  if (!tool) return "Action";
  const known = approvalTools[tool.toLowerCase()];
  if (known) return known;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  if (mcp) return `${humanize(mcp[1]!)} · ${humanize(mcp[2]!)}`;
  if (tool.includes("/")) return "Action";
  const words = humanize(tool);
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Action";
}

/** A tool step as a row reads it: "Opened `youtube.com`", "Called docs › search `TypeScript`". */
export interface ToolLabel {
  icon: "web" | "tool" | "agent" | "note" | "read" | "shell";
  verb: string;
  /** While it runs. */
  running: string;
  /** While it waits for approval, or after it was refused. */
  awaiting: string;
  target?: string | undefined;
}

const keyArguments = [
  "url",
  "query",
  "q",
  "path",
  "file_path",
  "filePath",
  "command",
  "title",
  "name",
  "role",
  "selector",
  "text",
  "message",
  "prompt",
  "threadId",
  "id",
];

function stringArgument(args: unknown, keys: readonly string[] = keyArguments) {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function oneLine(text: string | undefined, max = 72): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "https://www.youtube.com/watch?v=1" → "youtube.com/watch". */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return middleTruncate(host + path, 48);
  } catch {
    return middleTruncate(url, 48);
  }
}

const label = (
  icon: ToolLabel["icon"],
  verb: string,
  running: string,
  awaiting: string,
  target?: string,
): ToolLabel => ({ icon, verb, running, awaiting, target });

/** ace's own browser tools, keyed by action. */
function browserLabel(action: string, args: unknown): ToolLabel {
  const url = stringArgument(args, ["url"]);
  const where = url ? shortUrl(url) : undefined;
  switch (action) {
    case "open":
      return label("web", "Opened", "Opening", "Open", where ?? "a browser tab");
    case "navigate":
      return label("web", "Went to", "Going to", "Go to", where);
    case "close":
      return label(
        "web",
        "Closed the browser tab",
        "Closing the browser tab",
        "Close the browser tab",
      );
    case "snapshot":
      return label("web", "Read the page", "Reading the page", "Read the page");
    case "screenshot":
      return label("web", "Took a screenshot", "Taking a screenshot", "Take a screenshot");
    case "click":
      return label(
        "web",
        "Clicked",
        "Clicking",
        "Click",
        oneLine(stringArgument(args, ["text", "selector", "ref", "element"]), 48),
      );
    case "type":
      return label("web", "Typed", "Typing", "Type", oneLine(stringArgument(args, ["text"]), 48));
    case "scroll":
      return label("web", "Scrolled the page", "Scrolling the page", "Scroll the page");
    default:
      return label(
        "web",
        "Used the browser",
        "Using the browser",
        "Use the browser",
        humanize(action),
      );
  }
}

const screenTools: Record<string, [string, string, string]> = {
  screenshot: ["Took a screenshot", "Taking a screenshot", "Take a screenshot"],
  click: ["Clicked on the screen", "Clicking on the screen", "Click on the screen"],
  type: ["Typed on the screen", "Typing on the screen", "Type on the screen"],
  key: ["Pressed a key", "Pressing a key", "Press a key"],
  scroll: ["Scrolled the screen", "Scrolling the screen", "Scroll the screen"],
  ui_tree: ["Read the screen", "Reading the screen", "Read the screen"],
  ui_find: ["Searched the screen", "Searching the screen", "Search the screen"],
  ui_act: ["Used an app on screen", "Using an app on screen", "Use an app on screen"],
};

/** ace's own tools (ace_*), named for what they do with their key argument (A4). */
function aceToolLabel(name: string, args: unknown): ToolLabel | undefined {
  const browser = /^ace_browser_(.+)$/.exec(name);
  if (browser) return browserLabel(browser[1]!, args);
  const screen = /^screen_(.+)$/.exec(name);
  if (screen) {
    const forms = screenTools[screen[1]!];
    return forms ? label("tool", ...forms) : undefined;
  }
  const arg = (keys: readonly string[]) => oneLine(stringArgument(args, keys), 56);
  switch (name) {
    case "ace_thread_info":
      return label(
        "read",
        "Read this thread's details",
        "Reading this thread's details",
        "Read this thread's details",
      );
    case "ace_thread_read":
    case "ace_thread_read_output":
      return label(
        "read",
        "Read thread",
        "Reading thread",
        "Read thread",
        arg(["threadId", "title"]),
      );
    case "ace_list_agents":
      return label("agent", "Listed agents", "Listing agents", "List agents");
    case "ace_spawn_agent":
    case "ace_spawn":
      return label(
        "agent",
        "Started a subagent",
        "Starting a subagent",
        "Start a subagent",
        arg(["name", "role", "title"]),
      );
    case "ace_notify_user":
      return label(
        "note",
        "Notified you",
        "Notifying you",
        "Notify you",
        arg(["title", "message", "text"]),
      );
    case "ace_read_handoff":
    case "ace_read_handoff_chunk":
      return label(
        "read",
        "Read the handoff history",
        "Reading the handoff history",
        "Read the handoff history",
      );
    case "ace_wait":
      return label("agent", "Waited for subagents", "Waiting for subagents", "Wait for subagents");
    case "ace_thread_create":
      return label(
        "agent",
        "Created a thread",
        "Creating a thread",
        "Create a thread",
        arg(["title", "name"]),
      );
    case "ace_thread_message":
      return label(
        "agent",
        "Messaged a thread",
        "Messaging a thread",
        "Message a thread",
        arg(["message", "text"]),
      );
    case "ace_thread_interrupt":
      return label(
        "agent",
        "Stopped a thread",
        "Stopping a thread",
        "Stop a thread",
        arg(["threadId"]),
      );
    case "ace_question_answer":
      return label("note", "Answered a question", "Answering a question", "Answer a question");
    case "ace_project_read":
      return label("read", "Read project", "Reading project", "Read project", arg(["path"]));
    case "ace_automation_manage":
      return label(
        "tool",
        "Updated an automation",
        "Updating an automation",
        "Update an automation",
        arg(["name", "title"]),
      );
    case "ace_context_usage":
      return label("note", "Checked context use", "Checking context use", "Check context use");
    case "ace_models":
      return label("note", "Listed models", "Listing models", "List models");
    default:
      if (!name.startsWith("ace_")) return undefined;
      return label("tool", "Used ace", "Using ace", "Use ace", humanize(name.slice(4)));
  }
}

const computerUse = /^(cua|computer[-_ ]?use|computer)(?:[-_]|$)/i;

/**
 * An MCP tool step (A4): ace's own tools by what they do, computer-use as "the computer", and
 * any other server as "server › tool" with its key argument. Never "ace.ace_browser_open".
 */
export function mcpToolLabel(server: string, tool: string, args?: unknown): ToolLabel {
  const own =
    aceToolLabel(tool, args) ??
    (/^ace$|^ace[-_]/.test(server) ? aceToolLabel(`ace_${tool}`, args) : undefined);
  if (own) return own;
  if (computerUse.test(server) || computerUse.test(tool)) {
    if (/repl|js|python|script|exec/i.test(`${server} ${tool}`))
      return label(
        "tool",
        "Ran a computer-use script",
        "Running a computer-use script",
        "Run a computer-use script",
      );
    return label(
      "tool",
      "Used the computer",
      "Using the computer",
      "Use the computer",
      humanize(tool),
    );
  }
  const key = oneLine(stringArgument(args), 48);
  const name = `${humanize(server)} › ${humanize(tool)}`;
  return label("tool", "Called", "Calling", "Call", key ? `${name} ${key}` : name);
}

/** A tool the adapter knows only by name (browser, image, notebook, custom), as "Used …". */
export function namedToolLabel(kind: string, title: string): ToolLabel {
  const clean = oneLine(title, 72) ?? humanize(kind);
  if (kind === "browser") return label("web", "Browsed", "Browsing", "Browse", clean);
  if (computerUse.test(title))
    return label("tool", "Used the computer", "Using the computer", "Use the computer");
  return label("tool", "Used", "Using", "Use", clean);
}

/**
 * How tools and approvals read, injected into `describeStep`'s context so a row's first paint
 * doesn't carry their tables. Without them a step reads plainly ("Called docs › search", the
 * provider's title, "Awaiting approval") until they arrive.
 */
export interface StepLabels {
  mcp(server: string, tool: string, args?: unknown): ToolLabel;
  named(kind: string, title: string): ToolLabel;
  approval(
    interaction: Pick<Interaction, "state" | "request" | "resolution" | "review" | "autoReviewed">,
    answering?: string,
  ): ApprovalOutcome;
  /** A failure's reason, short enough for the row's note. */
  error(text: string | undefined): string | undefined;
}

/** Tool and approval wording for `describeStep`'s context (loaded after first paint). */
export const stepLabels: StepLabels = {
  mcp: mcpToolLabel,
  named: namedToolLabel,
  approval: approvalOutcome,
  error: errorNote,
};
