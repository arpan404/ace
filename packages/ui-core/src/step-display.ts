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
