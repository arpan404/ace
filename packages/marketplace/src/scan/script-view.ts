import type { MarketEntryType } from "@ace/protocol/marketplace";
import type { Inspection } from "../checks/index.ts";
import type { ScanInput } from "./index.ts";
import { readShell, type Simple } from "./shell.ts";
import { normaliseText } from "./text.ts";
import { scanText } from "./decode.ts";

/*
 * One script the scanner reads (ADR 0173 §8), the unit the `scripts`, `plugin` and `recipe` rules
 * run over. `viewsOf` yields a view for every skill script, plugin script file, hook command and
 * stdio server command (its words joined), and every recipe-bundled skill script, its text
 * NFKC-normalised with zero-width characters removed and, for a shell script, its simple commands
 * read through our port of Spade's shell reader. Pure.
 */

export type ScriptLanguage =
  | "shell"
  | "python"
  | "javascript"
  | "ruby"
  | "perl"
  | "powershell"
  | "applescript"
  | "text";

/** One simple command of a shell view, with the line it starts on and what it pipes into. */
export interface ViewCommand {
  words: string[];
  piped: boolean;
  /** The program name of the command this one's output is piped into, when it is piped. */
  pipedInto?: string;
  writesTo: string[];
  readsFrom: string[];
  line: number;
}

export interface ScriptView {
  path: string;
  language: ScriptLanguage;
  /** The script's text, NFKC-normalised with zero-width characters removed. */
  text: string;
  /** `text` split into lines, 0-based (line N is `lines[N - 1]`). */
  lines: string[];
  /** For a shell view, its simple commands; empty for other languages. */
  commands: ViewCommand[];
  /** A shell view the reader could not read for sure (backticks, `<(…)`, a pipe into a shell). */
  unreadable: boolean;
}

const BY_EXTENSION: ReadonlyMap<string, ScriptLanguage> = new Map<string, ScriptLanguage>(
  Object.entries({
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ksh: "shell",
    command: "shell",
    py: "python",
    pyw: "python",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "javascript",
    jsx: "javascript",
    tsx: "javascript",
    rb: "ruby",
    pl: "perl",
    pm: "perl",
    ps1: "powershell",
    psm1: "powershell",
    applescript: "applescript",
  } satisfies Record<string, ScriptLanguage>),
);

const SHEBANG: { pattern: RegExp; language: ScriptLanguage }[] = [
  { pattern: /\b(?:ba|z|k|da)?sh\b/, language: "shell" },
  { pattern: /\bpython[0-9.]*\b/, language: "python" },
  { pattern: /\b(?:node|deno|bun)\b/, language: "javascript" },
  { pattern: /\bruby\b/, language: "ruby" },
  { pattern: /\bperl\b/, language: "perl" },
  { pattern: /\b(?:pwsh|powershell)\b/, language: "powershell" },
  { pattern: /\bosascript\b/, language: "applescript" },
];

/** The language of a file by its extension, then its shebang; `text` when neither names one. */
export function languageOf(path: string, firstLine: string): ScriptLanguage {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  const byExt = BY_EXTENSION.get(ext);
  if (byExt) return byExt;
  if (firstLine.startsWith("#!")) {
    for (const { pattern, language } of SHEBANG) if (pattern.test(firstLine)) return language;
  }
  return "text";
}

/**
 * Reads `source` as a view at `path`, with the given language (or detected from its shebang). A
 * `text` view, a file in no language the scanner knows, is read by the shell reader too, since
 * it may be run as one; its `unreadable` stays false, as prose is full of lone quotes.
 */
export function viewOf(path: string, source: string, language?: ScriptLanguage): ScriptView {
  const normal = normaliseText(source);
  const lines = normal.split("\n");
  const chosen = language ?? languageOf(path, lines[0] ?? "");
  let commands: ViewCommand[] = [];
  let unreadable = false;
  if (chosen === "shell" || chosen === "text") {
    const read = readShell(normal);
    unreadable = chosen === "shell" && read.unreadable;
    commands = withPipeTargets(read.commands);
  }
  return { path, language: chosen, text: normal, lines, commands, unreadable };
}

/** Adds each command's `pipedInto` (the program the next command, when piped, receives). */
function withPipeTargets(commands: Simple[]): ViewCommand[] {
  return commands.map((command, index) => {
    const next = commands[index + 1];
    const pipedInto = next?.piped ? programName(next.words[0]) : undefined;
    return {
      words: command.words,
      piped: command.piped,
      ...(pipedInto ? { pipedInto } : {}),
      writesTo: command.writesTo,
      readsFrom: command.readsFrom,
      line: command.line,
    };
  });
}

function programName(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  const slash = word.lastIndexOf("/");
  return (slash < 0 ? word : word.slice(slash + 1)).toLowerCase();
}

const SKILL_SKIP = new Set(["SKILL.md", "market.json"]);

/** Whether a file of `type` is a place the script rules read (independent of its language). */
function isScriptLocation(type: MarketEntryType, path: string): boolean {
  switch (type) {
    case "spade-skill":
      return !SKILL_SKIP.has(path);
    case "spade-plugin":
      return path !== "market.json";
    case "spade-bot":
      return path.startsWith("skills/");
    case "suit":
    case "ace-plugin":
      return false;
  }
}

/**
 * The script view for one file of `type`, or undefined when the file is not a place scripts live.
 * Every text file there gets a view; one a plugin command names (`named`) is a script whatever
 * its name, read in the language that command runs it with, else its own, else as shell.
 */
export function fileScriptView(
  type: MarketEntryType,
  path: string,
  source: string,
  named?: NamedScript,
): ScriptView | undefined {
  if (!isScriptLocation(type, path)) return undefined;
  const detected = languageOf(path, source.split("\n", 1)[0] ?? "");
  const language = named
    ? (named.language ?? (detected === "text" ? "shell" : detected))
    : detected;
  return viewOf(path, source, language);
}

/** Whether a file reads as a script by its name or shebang, or because a plugin command names it. */
export function isScriptLike(path: string, source: string, named?: NamedScript): boolean {
  return named !== undefined || languageOf(path, source.split("\n", 1)[0] ?? "") !== "text";
}

/** A file a plugin hook or server command runs, with the language its interpreter gives. */
export interface NamedScript {
  language?: ScriptLanguage;
}

const INTERPRETER_LANGUAGE: ReadonlyMap<string, ScriptLanguage> = new Map<string, ScriptLanguage>([
  ["sh", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
  ["dash", "shell"],
  ["ksh", "shell"],
  ["source", "shell"],
  [".", "shell"],
  ["python", "python"],
  ["python2", "python"],
  ["python3", "python"],
  ["node", "javascript"],
  ["bun", "javascript"],
  ["deno", "javascript"],
  ["ruby", "ruby"],
  ["perl", "perl"],
  ["pwsh", "powershell"],
  ["powershell", "powershell"],
  ["osascript", "applescript"],
]);

/** `${PLUGIN_ROOT}/`, `$ROOT/` and `./` in front of a path, any number of them. */
const pathPrefix = /^(?:(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\.)\/)+/;

/**
 * The entry's files a plugin hook or stdio server command names, by path. A command word names a
 * file when, with its root variable or `./` taken off, it is that file's path.
 */
export function namedScripts(input: ScanInput): ReadonlyMap<string, NamedScript> {
  const named = new Map<string, NamedScript>();
  if (input.type !== "spade-plugin" || input.inspection?.type !== "spade-plugin") return named;
  const paths = new Set(input.files.map((file) => file.path));
  for (const execution of input.inspection.executions) {
    const commands =
      execution.kind === "hook"
        ? readShell(execution.command).commands.map((command) => command.words)
        : execution.kind === "stdio"
          ? [[execution.command, ...execution.args]]
          : [];
    for (const words of commands)
      for (const [index, word] of words.entries()) {
        const path = word.replace(pathPrefix, "");
        if (!paths.has(path) || named.has(path)) continue;
        const before = index > 0 ? programName(words[index - 1]) : undefined;
        const language = before === undefined ? undefined : INTERPRETER_LANGUAGE.get(before);
        named.set(path, language ? { language } : {});
      }
  }
  return named;
}

/** Hook commands and stdio server command lines of a plugin, each as a shell view (non-file). */
export function commandViews(input: ScanInput): ScriptView[] {
  if (input.type !== "spade-plugin") return [];
  return pluginCommandViews(input.inspection);
}

/** Every script the scanner reads for `input`: skill scripts, plugin commands, recipe skills. */
export function viewsOf(input: ScanInput): ScriptView[] {
  const views: ScriptView[] = [];
  const seen = new Set<string>();
  const add = (view: ScriptView) => {
    if (seen.has(view.path)) return;
    seen.add(view.path);
    views.push(view);
  };
  const named = namedScripts(input);
  for (const file of input.files) {
    const source = scanText(file.content)?.text;
    if (source === undefined) continue;
    const view = fileScriptView(input.type, file.path, source, named.get(file.path));
    if (view) add(view);
  }
  for (const view of commandViews(input)) add(view);
  return views;
}

/** Hook commands and stdio server command lines of a plugin, each as a shell view. */
function pluginCommandViews(inspection: Inspection | undefined): ScriptView[] {
  if (inspection?.type !== "spade-plugin") return [];
  const views: ScriptView[] = [];
  let hookIndex = 0;
  let serverIndex = 0;
  for (const execution of inspection.executions) {
    if (execution.kind === "hook") {
      views.push(viewOf(`plugin:hook/${hookIndex++}`, execution.command, "shell"));
    } else if (execution.kind === "stdio") {
      const line = [execution.command, ...execution.args].join(" ");
      views.push(viewOf(`plugin:server/${execution.name}#${serverIndex++}`, line, "shell"));
    }
  }
  return views;
}

/** Collects URL hosts seen in a script's text, lower-cased: a fact the whole-entry rules read. */
export function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/([^\s/"'`)\]}>,;]+)/gi)) {
    const authority = match[1];
    if (!authority) continue;
    const host = authority.split("@").at(-1)?.split(":")[0]?.toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/** The entry type guard, kept here so a caller needn't import the protocol. */
export const isEntryType = (value: string): value is MarketEntryType =>
  value === "suit" ||
  value === "spade-skill" ||
  value === "spade-plugin" ||
  value === "spade-bot" ||
  value === "ace-plugin";
