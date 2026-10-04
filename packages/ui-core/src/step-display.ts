import { describeProviderError } from "./error-display.ts";

/*
 * How provider data reads on screen: project-relative paths, the command a person typed
 * rather than the login shell that ran it, and tools named for what they do. Every surface
 * (work-log rows, step details, approvals, changed files) goes through these, so a path or a
 * tool never reads two ways. Pure.
 */

/** Where a step ran, to shorten its paths. Every field is optional. */
export interface PathContext {
  /** The agent's working directory: paths inside it read relative. */
  cwd?: string | undefined;
  /** The daemon host's home directory; inferred from `cwd` or the path when unknown. */
  home?: string | undefined;
  /** Other ace worktrees of the same project, so their paths read "[branch] src/x.ts". */
  worktrees?: readonly { path: string; branch: string }[] | undefined;
}

export interface DisplayPath {
  /** "src/app.tsx", "~/notes.md", "[ace/fix-login] src/x.ts" or the skill's name. */
  text: string;
  /** The path as given, for the tooltip and the expanded detail. */
  full: string;
  /** Set when the path is inside a skill: the skill's name. */
  skill?: string | undefined;
}

const trim = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);

/** "/Users/ada" for "/Users/ada/src/x.ts"; also Linux homes and Windows profiles. */
export function inferHome(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/.exec(
    path,
  );
  return match?.[1];
}

/** `path` relative to `dir`, or undefined when it is not inside it. */
function inside(path: string, dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const base = trim(dir);
  if (path === base) return ".";
  for (const separator of ["/", "\\"])
    if (path.startsWith(base + separator)) return path.slice(base.length + 1);
  return undefined;
}

const skillPath = /[\\/]\.(?:agents|claude|codex)[\\/]skills[\\/]([^\\/]+)(?:[\\/]|$)/;
const worktreePath = /[\\/]\.ace(?:-next)?[\\/]worktrees[\\/]([^\\/]+)(?:[\\/](.*))?$/;

/** Long paths keep their first directory and last two segments: "src/…/deep/file.ts". */
export function middleTruncate(path: string, max = 56): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  if (parts.length > 3) {
    const short = `${parts[0]}/…/${parts.slice(-2).join("/")}`;
    if (short.length <= max) return short;
  }
  const keep = max - 1;
  return `${path.slice(0, Math.ceil(keep / 3))}…${path.slice(-Math.floor((keep * 2) / 3))}`;
}

/**
 * A path as a row shows it (IR-6): relative inside the working directory, "[branch] …" inside
 * another worktree of the project, the skill's name inside a skill, "~/…" elsewhere under home,
 * else absolute. Long results are middle-truncated; `full` keeps the original.
 */
export function stepPath(path: string, context: PathContext = {}): DisplayPath {
  const full = path;
  const clean = trim(path);
  const skill = skillPath.exec(clean)?.[1];
  if (skill) return { text: skill, full, skill };
  const own = inside(clean, context.cwd);
  // The working directory itself reads by where it is ("~/relay"), never ".".
  if (own !== undefined && own !== ".") return { text: middleTruncate(own), full };
  for (const tree of context.worktrees ?? []) {
    const relative = inside(clean, tree.path);
    if (relative !== undefined)
      return { text: `[${tree.branch}] ${middleTruncate(relative)}`, full };
  }
  const tree = worktreePath.exec(clean);
  if (tree) {
    // An ace worktree. Without a working directory it is the agent's own; with one, another.
    const relative = tree[2] ?? ".";
    const text = context.cwd ? `[worktree ${tree[1]?.slice(0, 8)}] ${relative}` : relative;
    return { text: middleTruncate(text), full };
  }
  const home = context.home ?? inferHome(context.cwd) ?? inferHome(clean);
  const underHome = inside(clean, home);
  if (underHome !== undefined)
    return { text: middleTruncate(underHome === "." ? "~" : `~/${underHome}`), full };
  return { text: middleTruncate(clean), full };
}

/* ---------------------------------------------------------------------------------------- */
/* Commands                                                                                  */

/**
 * Reads one shell word made only of quoted parts (`'a b'`, `"a \"b\""`, `'it'\''s'`) and returns
 * its value, or undefined when anything else is in it: unquoted spaces, operators, a second
 * word, an unterminated quote.
 */
function quotedWord(text: string): string | undefined {
  let value = "";
  let index = 0;
  let quoted = false;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return undefined;
      value += text.slice(index + 1, end);
      index = end + 1;
      quoted = true;
    } else if (char === '"') {
      index++;
      let closed = false;
      while (index < text.length) {
        const inner = text[index];
        if (inner === "\\" && index + 1 < text.length && '"\\$`\n'.includes(text[index + 1]!)) {
          value += text[index + 1];
          index += 2;
        } else if (inner === '"') {
          closed = true;
          index++;
          break;
        } else {
          value += inner;
          index++;
        }
      }
      if (!closed) return undefined;
      quoted = true;
    } else if (char === "\\" && index + 1 < text.length) {
      // The `'\''` idiom: an escaped quote between two single-quoted runs.
      value += text[index + 1];
      index += 2;
    } else return undefined;
  }
  return quoted ? value : undefined;
}

const wrapper =
  /^(?:(?:\/[\w.+-]+)*\/)?(sh|bash|zsh|dash|fish|ksh)\s+(?:-lc|-c|-l\s+-c|-cl)\s+(.+)$/s;

/**
 * The script inside a login-shell wrapper, `/bin/zsh -lc 'bun install'` → `bun install`.
 * Only the exact form `<shell> -lc|-c '<script>'` (single or double quoted, nothing after it)
 * unwraps; anything else is returned as undefined and shown as given.
 */
export function unwrapShellCommand(command: string): { inner: string; shell: string } | undefined {
  const match = wrapper.exec(command.trim());
  if (!match) return undefined;
  const inner = quotedWord(match[2]!);
  if (inner === undefined || !inner.trim()) return undefined;
  return { inner: inner.trim(), shell: match[1]! };
}

export interface DisplayCommand {
  /** What the person would have typed: "bun install --frozen-lockfile". */
  command: string;
  /** The exact string the provider ran, when it differs. */
  raw?: string | undefined;
}

/**
 * A shell step's command as shown (IR-5): the adapter's readable `command` when it also sent
 * `rawCommand`, else the command with its login-shell wrapper removed here.
 */
export function displayCommand(detail: { command: string; rawCommand?: string }): DisplayCommand {
  if (detail.rawCommand !== undefined)
    return {
      command: detail.command,
      raw: detail.rawCommand === detail.command ? undefined : detail.rawCommand,
    };
  const unwrapped = unwrapShellCommand(detail.command);
  return unwrapped
    ? { command: unwrapped.inner, raw: detail.command }
    : { command: detail.command };
}

/* ---------------------------------------------------------------------------------------- */
/* Tools                                                                                     */

/** "browser_open" → "browser open". */
export function humanize(name: string): string {
  return name
    .replace(/^mcp__/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
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

/** An error in words, short enough for a row's trailing note (A4); the full text is in the detail. */
export function errorNote(error: string | undefined, max = 60): string | undefined {
  if (!error?.trim()) return undefined;
  const title = describeProviderError({ text: error }).title;
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}
