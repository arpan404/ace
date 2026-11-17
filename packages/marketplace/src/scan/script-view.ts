import type { MarketEntryType } from "@ace/protocol/marketplace";
import type { Inspection } from "../checks/index.ts";
import type { ScanInput } from "./index.ts";
import { readShell, type Simple } from "./shell.ts";
import { normaliseText } from "./text.ts";
import { scanText } from "./decode.ts";
import { instructionScripts, type InstructionScript } from "./instructions.ts";

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
    unreadable =
      chosen === "shell" &&
      (read.unreadable || read.commands.some((command) => evalsUnknown(command, normal)));
    commands = withPipeTargets(read.commands);
  }
  return { path, language: chosen, text: normal, lines, commands, unreadable };
}

/**
 * Whether a command is `eval` of text the reader can't see: a variable in its arguments
 * (`eval "$UNKNOWN"`). `eval "$(brew shellenv)"` is read, since the reader reads the command
 * inside `$(…)` as one the view holds; it writes each substitution as `$SUB`, so that word only
 * counts as one when the command's source line has a `$(` (else it is a variable named `SUB`).
 */
function evalsUnknown(command: Simple, source: string): boolean {
  if (programName(command.words[0]) !== "eval") return false;
  const line = source.split("\n")[command.line - 1] ?? "";
  const substituted = line.includes("$(");
  return command.words
    .slice(1)
    .some((word) => (substituted ? word.replaceAll("$SUB", "") : word).includes("$"));
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
 * its name, read in the language that command runs it with, else its own. When neither is known,
 * it is read by the shell reader as a shell script (an unreadable part counts) and by every
 * language's token patterns, as a `text` view is, since what runs it is uncertain.
 */
export function fileScriptView(
  type: MarketEntryType,
  path: string,
  source: string,
  named?: NamedScript,
): ScriptView | undefined {
  if (!isScriptLocation(type, path)) return undefined;
  const detected = languageOf(path, source.split("\n", 1)[0] ?? "");
  if (!named) return viewOf(path, source, detected);
  if (named.language) return viewOf(path, source, named.language);
  if (detected !== "text") return viewOf(path, source, detected);
  return { ...viewOf(path, source, "shell"), language: "text" };
}

/** Whether a file reads as a script by its name or shebang, or because a plugin command names it. */
export function isScriptLike(path: string, source: string, named?: NamedScript): boolean {
  return named !== undefined || languageOf(path, source.split("\n", 1)[0] ?? "") !== "text";
}

/**
 * A file a plugin hook or server command runs, with the language its interpreter gives; no
 * language when the command doesn't say for sure.
 */
export interface NamedScript {
  language?: ScriptLanguage;
}

const INTERPRETER_LANGUAGE: ReadonlyMap<string, ScriptLanguage> = new Map<string, ScriptLanguage>([
  ["sh", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
  ["dash", "shell"],
  ["ash", "shell"],
  ["mksh", "shell"],
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
 * Options of each interpreter that take the next word as their value, so the word after them is
 * not the script. Long options written `--flag=value` carry their own value.
 */
const VALUED_OPTIONS: ReadonlyMap<ScriptLanguage, ReadonlySet<string>> = new Map([
  ["shell", new Set(["-o", "-O", "+o", "+O", "--rcfile", "--init-file"])],
  ["python", new Set(["-W", "-X", "-Q"])],
  [
    "javascript",
    new Set([
      "-r",
      "--require",
      "--import",
      "--loader",
      "--experimental-loader",
      "-C",
      "--conditions",
      "--config",
      "--cwd",
      "--env-file",
      "--preload",
      "--title",
    ]),
  ],
  ["ruby", new Set(["-I", "-r", "-C", "-E", "-F", "--encoding"])],
  ["perl", new Set(["-I", "-M", "-m", "-x"])],
  [
    "powershell",
    new Set(["-ExecutionPolicy", "-ep", "-WorkingDirectory", "-wd", "-ConfigurationName"]),
  ],
  ["applescript", new Set(["-l", "-s"])],
]);

/** Options after which each interpreter runs inline code or a module, never a script file. */
const CODE_OPTIONS: ReadonlyMap<ScriptLanguage, ReadonlySet<string>> = new Map([
  ["shell", new Set(["-c"])],
  ["python", new Set(["-c", "-m"])],
  ["javascript", new Set(["-e", "-p", "--eval", "--print"])],
  ["ruby", new Set(["-e"])],
  ["perl", new Set(["-e", "-E"])],
  ["powershell", new Set(["-c", "-Command", "-EncodedCommand", "-e", "-ec"])],
  ["applescript", new Set(["-e"])],
]);

/** Runtimes that take a `run` subcommand before their script (`deno run x`, `bun run x`). */
const RUN_SUBCOMMAND = new Set(["deno", "bun"]);

/**
 * The index of the script `words` (a command, wrappers already off) runs with the language of its
 * interpreter, or undefined when its program is no interpreter we know or it runs no script file.
 */
function interpretedScript(
  words: readonly string[],
): { index: number; language: ScriptLanguage } | undefined {
  const program = programName(words[0]) ?? "";
  const language = INTERPRETER_LANGUAGE.get(program);
  if (language === undefined) return undefined;
  const valued = VALUED_OPTIONS.get(language) ?? new Set<string>();
  const code = CODE_OPTIONS.get(language) ?? new Set<string>();
  let subcommand = RUN_SUBCOMMAND.has(program);
  for (let index = 1; index < words.length; index++) {
    const word = words[index] ?? "";
    if (word === "--") return index + 1 < words.length ? { index: index + 1, language } : undefined;
    if (subcommand && word === "run") {
      subcommand = false;
      continue;
    }
    if (
      word.length > 1 &&
      (word.startsWith("-") || (language === "shell" && word.startsWith("+")))
    ) {
      if (code.has(word)) return undefined;
      if (valued.has(word)) index++;
      continue;
    }
    return { index, language };
  }
  return undefined;
}

/**
 * The file a shell or interpreter command (wrappers already off) runs as its script: `sh -eu x`,
 * `source x`, `. x`, `python3 -u x`, `node --require r x` all name `x`. Undefined when the
 * program is no interpreter we know, or it runs inline code or a module (`-c`, `-e`, `-m`) or
 * nothing at all.
 */
export function scriptOperand(words: readonly string[]): string | undefined {
  const script = interpretedScript(words);
  return script === undefined ? undefined : words[script.index];
}

/** A stdio server's command and arguments as one shell line, each word quoted as it is. */
const quotedLine = (words: readonly string[]) =>
  words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");

/**
 * The entry's files a plugin hook or stdio server command names, by path. A command word names a
 * file when, with its root variable or `./` taken off, it is that file's path. Commands are read
 * through the shell reader, so wrappers (`env`, `nohup`, `env -S`) are off and the program is the
 * first word. A file is read in its interpreter's language only when it is that interpreter's
 * script argument (its options skipped); named any other way, or by two interpreters that
 * disagree, its language is uncertain (`{}`).
 */
export function namedScripts(input: ScanInput): ReadonlyMap<string, NamedScript> {
  const named = new Map<string, NamedScript>();
  if (input.type !== "spade-plugin" || input.inspection?.type !== "spade-plugin") return named;
  const paths = new Set(input.files.map((file) => file.path));
  for (const execution of input.inspection.executions) {
    const line =
      execution.kind === "hook"
        ? execution.command
        : execution.kind === "stdio"
          ? quotedLine([execution.command, ...execution.args])
          : undefined;
    if (line === undefined) continue;
    for (const { words } of readShell(line).commands) {
      const script = interpretedScript(words);
      for (const [index, word] of words.entries()) {
        const path = word.replace(pathPrefix, "");
        if (!paths.has(path)) continue;
        const language = script?.index === index ? script.language : undefined;
        const earlier = named.get(path);
        named.set(
          path,
          language && (earlier === undefined || earlier.language === language) ? { language } : {},
        );
      }
    }
  }
  return named;
}

/**
 * The views read once per entry, beside its files: a plugin's hook commands and stdio server
 * command lines, each as a shell view, and the commands its instructions give an agent.
 */
export function commandViews(input: ScanInput): ScriptView[] {
  const plugin = input.type === "spade-plugin" ? pluginCommandViews(input.inspection) : [];
  return [...plugin, ...instructionViews(input)];
}

/**
 * The code an entry's instructions tell an agent to run (`instructions.ts`): fenced and indented
 * blocks, inline commands and command lines of a skill's SKILL.md, a plugin's markdown and
 * description, and a recipe's task, blurb, notes and routines. Never exempt: a SKILL.md that
 * says to pipe a download into a shell is read like a script that does. Each view keeps its
 * source's path and line numbers; a fenced block is read in its tag's language, and everything
 * else as a `text` view (the shell reader and every language's token patterns).
 */
export function instructionViews(input: ScanInput): ScriptView[] {
  const readWhole = (path: string, source: string) =>
    fileScriptView(input.type, path, source) !== undefined;
  const views = instructionScripts(input, readWhole).map((script) =>
    viewOf(script.path, script.text, script.language),
  );
  // Fail closed (§8): an executable snippet the reader can't read holds its source. Read with
  // every block extracted, so a fence in a file the rules read whole (a skill's README.md, a
  // `text` view whose flag prose would clear) is held too.
  for (const script of instructionScripts(input, () => false)) {
    if (!snippetUnreadable(script)) continue;
    const ofPath = views.filter((view) => view.path === script.path);
    if (ofPath.some((view) => view.unreadable)) continue;
    const view = ofPath[0];
    if (view) view.unreadable = true;
    else views.push({ ...viewOf(script.path, ""), unreadable: true });
  }
  return views;
}

/** A program-like first word: a name or a path, as a command line starts. */
const programStart = /^(?:\.{0,2}\/|~\/)?[A-Za-z_][\w.+-]*(?:\/[\w.+-]+)*(?:\s|$)/;

/**
 * Whether one masked instruction script holds an executable snippet the reader can't read for
 * sure. A shell snippet is read whole. A `text` snippet (an untagged fence, an indented block,
 * an inline command, a command line) is read line by line, and only a line that starts like a
 * command counts, with apostrophes inside words (`don't`) taken out first, since prose is full
 * of them; a prose line, or one a lone apostrophe alone made unreadable, stays clean. Other
 * languages have no shell reading to lose.
 */
function snippetUnreadable(script: InstructionScript): boolean {
  if (script.language === "shell") {
    const text = normaliseText(script.text);
    const read = readShell(text);
    return read.unreadable || read.commands.some((command) => evalsUnknown(command, text));
  }
  if (script.language !== "text") return false;
  for (const raw of normaliseText(script.text).split("\n")) {
    const line = raw.trim().replace(/^\$\s+/, "");
    if (!programStart.test(line)) continue;
    const command = line.replaceAll(/(?<=\p{L})'(?=\p{L})/gu, "");
    const read = readShell(command);
    if (read.unreadable || read.commands.some((simple) => evalsUnknown(simple, command)))
      return true;
  }
  return false;
}

/**
 * Every script the scanner reads for `input`: skill scripts, plugin commands, recipe skills, and
 * the commands its instructions give an agent.
 */
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
  // Instruction views share their file's path, so they are kept beside its view, not deduped.
  views.push(...commandViews(input));
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
