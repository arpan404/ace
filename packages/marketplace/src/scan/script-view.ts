import type { MarketEntryType } from "@ace/protocol/marketplace";
import { text as decodeText } from "../listing.ts";
import type { Inspection } from "../checks/index.ts";
import type { ScanInput } from "./index.ts";
import { readShell, type Simple } from "./shell.ts";
import { normaliseText } from "./text.ts";

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

const BY_EXTENSION: Record<string, ScriptLanguage> = {
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
};

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
  const byExt = BY_EXTENSION[ext];
  if (byExt) return byExt;
  if (firstLine.startsWith("#!")) {
    for (const { pattern, language } of SHEBANG) if (pattern.test(firstLine)) return language;
  }
  return "text";
}

/** Reads `source` as a view at `path`, with the given language (or detected from its shebang). */
export function viewOf(path: string, source: string, language?: ScriptLanguage): ScriptView {
  const normal = normaliseText(source);
  const lines = normal.split("\n");
  const chosen = language ?? languageOf(path, lines[0] ?? "");
  let commands: ViewCommand[] = [];
  let unreadable = false;
  if (chosen === "shell") {
    const read = readShell(normal);
    unreadable = read.unreadable;
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

/** The script view for one file of `type`, or undefined when the file is not a script here. */
export function fileScriptView(
  type: MarketEntryType,
  path: string,
  source: string,
): ScriptView | undefined {
  if (!isScriptLocation(type, path)) return undefined;
  const language = languageOf(path, source.split("\n", 1)[0] ?? "");
  if (language === "text") return undefined;
  return viewOf(path, source, language);
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
  for (const file of input.files) {
    const source = decodeText(file.content);
    if (source === undefined) continue;
    const view = fileScriptView(input.type, file.path, source);
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
