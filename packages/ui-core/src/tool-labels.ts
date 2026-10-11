import type { Interaction, Item } from "@ace/protocol";
import { approvalOutcome, type ApprovalOutcome } from "./approvals.ts";
import {
  aceToolSpec,
  aceToolView,
  aceToolWords,
  screenStep,
  screenStepView,
  aceCallOf,
  type AceToolContext,
  type AceToolFamily,
  type AceToolView,
} from "./ace-tools.ts";
import { humanize } from "./tool-names.ts";

/*
 * Tool steps named for what they did (A4): ace's own tools by their action and key argument,
 * computer use as "the computer", other MCP servers as tool actions. Pure.
 */

export { humanize } from "./tool-names.ts";

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

/** A tool step as a row reads it: "Opened `youtube.com`", "Used a tool `TypeScript`". */
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

export { shortUrl } from "./ace-tool-specs.ts";

const label = (
  icon: ToolLabel["icon"],
  verb: string,
  running: string,
  awaiting: string,
  target?: string,
): ToolLabel => ({ icon, verb, running, awaiting, target });

const familyIcons: Record<AceToolFamily, ToolLabel["icon"]> = {
  screen: "tool",
  browser: "web",
  device: "tool",
  agents: "agent",
  threads: "read",
  ace: "note",
};

/** ace's own tools (ace_*, screen_*, device_*), by the registry's words (A4). */
function aceToolLabel(server: string, tool: string, args: unknown): ToolLabel | undefined {
  const spec = aceToolSpec(server, tool);
  const words = spec && aceToolWords(server, tool, args);
  if (!spec || !words) return undefined;
  return label(familyIcons[spec.family], words.past, words.running, words.awaiting, words.target);
}

const computerUse = /^(cua|computer[-_ ]?use|computer)(?:[-_]|$)/i;

/**
 * An MCP tool step (A4): ace's own tools by what they do, computer-use as "the computer", and
 * any other server as a tool action with its key argument. Never "ace.ace_browser_open".
 */
export function mcpToolLabel(server: string, tool: string, args?: unknown): ToolLabel {
  const own = aceToolLabel(server, tool, args);
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
  return label("tool", "Used a tool", "Using a tool", "Use a tool", key);
}

/** A tool the adapter knows only by name (browser, image, notebook, custom), as "Used …". */
export function namedToolLabel(kind: string, title: string): ToolLabel {
  if (/›|mcp__|^(?:ace_|screen_|device_)/.test(title))
    return label("tool", "Used a tool", "Using a tool", "Use a tool");
  const clean = oneLine(title, 72) ?? humanize(kind);
  if (kind === "browser") return label("web", "Browsed", "Browsing", "Browse", clean);
  if (computerUse.test(title))
    return label("tool", "Used the computer", "Using the computer", "Use the computer");
  return label("tool", "Used", "Using", "Use", clean);
}

/**
 * How tools and approvals read, injected into `describeStep`'s context so a row's first paint
 * doesn't carry their tables. Without them a step reads plainly ("Used a tool", "Awaiting approval") until they arrive.
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
  /** One of ace's own steps (a call, or the daemon's audit of one) as its row reads it. */
  ace(item: Item, context?: AceToolContext): AceToolView | undefined;
}

/** ace's own step: its call against the registry, or the daemon's audit of one on its own. */
export function aceStep(item: Item, context?: AceToolContext): AceToolView | undefined {
  const step = screenStep(item);
  if (step) return screenStepView(step);
  const call = aceCallOf(item);
  return call && aceToolView(call, context);
}

/** Tool and approval wording for `describeStep`'s context (loaded after first paint). */
export const stepLabels: StepLabels = {
  mcp: mcpToolLabel,
  named: namedToolLabel,
  approval: approvalOutcome,
  error: errorNote,
  ace: aceStep,
};
