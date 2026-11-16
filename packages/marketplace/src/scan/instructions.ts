import type { ScanInput } from "./index.ts";
import type { ScriptLanguage } from "./script-view.ts";
import { scanText } from "./decode.ts";

/*
 * Commands an entry's instructions tell an agent to run (ADR 0173 §8). An agent reads a skill's
 * SKILL.md, a plugin's README, AGENTS, CLAUDE and docs markdown, a recipe's task, blurb, notes
 * and routines, and a plugin's description, and runs what they say, so the code in them is read
 * as scripts are: fenced blocks (any tag or none), indented blocks, inline backtick spans that
 * read as a command, and command lines (`Run: …`, `then run …`, `$ …`).
 *
 * Each source becomes one masked script per language: every line that holds no snippet of that
 * language is blank, so a rule's line number is the source's own line. Pure, linear in the text,
 * and bounded: each source is read to 1 MiB, each line to 20,000 characters, at most 256
 * snippets per source and 512 KiB of snippet text per entry.
 */

/** One masked script from an instruction source, its lines aligned with the source's. */
export interface InstructionScript {
  path: string;
  language: ScriptLanguage;
  text: string;
}

const MAX_SOURCE_CHARS = 1024 * 1024;
const MAX_LINE_CHARS = 20_000;
const MAX_SNIPPETS = 256;
const MAX_ENTRY_CHARS = 512 * 1024;

/** The files an agent reads as instructions. */
const instructionFile =
  /(?:^|\/)(?:SKILL|AGENTS|CLAUDE|README|instructions?|prompt)\.md$|\.(?:md|mdc|markdown|txt|prompt)$/i;

const FENCE_LANGUAGE: ReadonlyMap<string, ScriptLanguage> = new Map<string, ScriptLanguage>(
  Object.entries({
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ksh: "shell",
    dash: "shell",
    shell: "shell",
    console: "shell",
    "shell-session": "shell",
    "sh-session": "shell",
    terminal: "shell",
    py: "python",
    python: "python",
    python3: "python",
    js: "javascript",
    javascript: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "javascript",
    typescript: "javascript",
    tsx: "javascript",
    node: "javascript",
    rb: "ruby",
    ruby: "ruby",
    pl: "perl",
    perl: "perl",
    ps: "powershell",
    ps1: "powershell",
    pwsh: "powershell",
    powershell: "powershell",
    applescript: "applescript",
    osascript: "applescript",
  } satisfies Record<string, ScriptLanguage>),
);

/** Fence tags whose lines mix prompts with output: only the `$ ` lines are commands. */
const SESSION_TAGS = new Set(["console", "shell-session", "sh-session", "terminal"]);

const fenceOpen = /^ {0,3}(`{3,}|~{3,})\s*([^\s`{]*)/;
const indented = /^(?: {4}|\t)/;
const blank = /^\s*$/;
const prompt = /^\s*\$\s+(\S.*)$/;
const inlineSpan = /`([^`\n]{1,2000})`/g;
/** A span reads as a command when it starts with a program-like word and has more than one word. */
const commandLike =
  /^(?:sudo\s+)?(?:\.{0,2}\/|~\/)?[A-Za-z_][\w.+-]*(?:\/[\w.+-]+)*\s+\S|^\.{0,2}\/\S/;
const commandLines: readonly RegExp[] = [
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\$\s+(\S.*)$/,
  /\b(?:run|execute|exec|paste|enter|type)(?:\s+(?:this|the\s+following|this\s+command|the\s+command))?\s*:\s*(\S.*)$/i,
  /\bthen\s+run\s+(\S.*)$/i,
];

/** A snippet: a line of code at a source line (0-based), in a language. */
interface Snippet {
  line: number;
  text: string;
  language: ScriptLanguage;
}

/** Every instruction source of `input`, as path and text, with whether its whole text is read. */
function sourcesOf(
  input: ScanInput,
  readWhole: (path: string, source: string) => boolean,
): { path: string; text: string; whole: boolean }[] {
  const out: { path: string; text: string; whole: boolean }[] = [];
  const add = (path: string, text: string, whole = false) =>
    out.push({ path, text: text.slice(0, MAX_SOURCE_CHARS), whole });
  if (input.inspection?.type === "spade-bot") {
    const { recipe } = input.inspection;
    add("recipe:task", recipe.task);
    add("recipe:blurb", recipe.blurb);
    for (const [index, note] of recipe.notes.entries()) add(`recipe:note/${index + 1}`, note);
    for (const routine of recipe.routines)
      add(`recipe:routine/${routine.name}`, routine.instruction);
  }
  if (input.type === "spade-plugin" && input.listing.description)
    add("plugin:description", input.listing.description);
  if (input.type === "spade-skill" || input.type === "spade-bot" || input.type === "spade-plugin")
    for (const file of input.files) {
      if (!instructionFile.test(file.path)) continue;
      const text = scanText(file.content)?.text;
      if (text !== undefined) add(file.path, text, readWhole(file.path, text));
    }
  return out;
}

/**
 * The snippets of one source. A source whose whole text the script rules already read (`whole`)
 * gives only its inline spans and command lines, since its block lines are read as they are.
 */
function snippetsOf(text: string, whole: boolean): Snippet[] {
  const snippets: Snippet[] = [];
  const lines = text.split("\n");
  let fence: { marker: string; language: ScriptLanguage; session: boolean } | undefined;
  let inIndented = false;
  for (let index = 0; index < lines.length && snippets.length < MAX_SNIPPETS; index++) {
    const raw = lines[index] ?? "";
    const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
    if (fence) {
      const trimmed = line.trim();
      if (trimmed.startsWith(fence.marker) && /^(`+|~+)$/.test(trimmed)) {
        fence = undefined;
        continue;
      }
      if (whole) continue;
      const code = fence.session ? prompt.exec(line)?.[1] : (prompt.exec(line)?.[1] ?? line);
      if (code !== undefined && !blank.test(code))
        snippets.push({ line: index, text: code, language: fence.language });
      continue;
    }
    const open = fenceOpen.exec(line);
    if (open) {
      const tag = (open[2] ?? "").toLowerCase();
      fence = {
        marker: open[1] ?? "```",
        language: FENCE_LANGUAGE.get(tag) ?? "text",
        session: SESSION_TAGS.has(tag),
      };
      inIndented = false;
      continue;
    }
    const previousBlank = index === 0 || blank.test(lines[index - 1] ?? "");
    if (indented.test(line) && !blank.test(line) && (inIndented || previousBlank)) {
      inIndented = true;
      if (!whole)
        snippets.push({ line: index, text: line.replace(indented, ""), language: "text" });
      continue;
    }
    if (!blank.test(line)) inIndented = false;
    const spans: string[] = [];
    for (const match of line.matchAll(inlineSpan)) {
      const span = (match[1] ?? "").trim();
      if (commandLike.test(span)) spans.push(span);
    }
    if (spans.length > 0) {
      snippets.push({ line: index, text: spans.join(" ; "), language: "text" });
      continue;
    }
    for (const pattern of commandLines) {
      const command = pattern.exec(line)?.[1];
      if (command === undefined) continue;
      snippets.push({ line: index, text: command, language: "text" });
      break;
    }
  }
  return snippets;
}

/**
 * The masked scripts of every instruction source of `input`. `readWhole` says whether the script
 * rules already read a file's whole text (a plugin's README does; a skill's SKILL.md doesn't).
 */
export function instructionScripts(
  input: ScanInput,
  readWhole: (path: string, source: string) => boolean,
): InstructionScript[] {
  const scripts: InstructionScript[] = [];
  let budget = MAX_ENTRY_CHARS;
  for (const source of sourcesOf(input, readWhole)) {
    if (budget <= 0) break;
    const snippets = snippetsOf(source.text, source.whole);
    if (snippets.length === 0) continue;
    const lineCount = (snippets.at(-1)?.line ?? 0) + 1;
    const masked = new Map<ScriptLanguage, string[]>();
    for (const snippet of snippets) {
      if (budget <= 0) break;
      const text = snippet.text.slice(0, budget);
      budget -= text.length;
      let lines = masked.get(snippet.language);
      if (!lines) {
        lines = Array.from({ length: lineCount }, () => "");
        masked.set(snippet.language, lines);
      }
      lines[snippet.line] = text;
    }
    for (const [language, lines] of masked)
      scripts.push({ path: source.path, language, text: lines.join("\n") });
  }
  return scripts;
}
