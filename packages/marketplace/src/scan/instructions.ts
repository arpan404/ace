import type { MarketScanFinding } from "@ace/protocol/marketplace";
import type { ScanInput } from "./index.ts";
import type { ScriptLanguage } from "./script-view.ts";
import { scanText } from "./decode.ts";
import { held, truncated } from "./fail-closed.ts";

/*
 * Commands an entry's instructions tell an agent to run (ADR 0173 §8). An agent reads a skill's
 * SKILL.md, a plugin's README, AGENTS, CLAUDE and docs markdown, a recipe's task, blurb, notes
 * and routines, and a plugin's description, and runs what they say, so the code in them is read
 * as scripts are: fenced blocks (any tag or none), indented blocks, inline backtick spans that
 * read as a command, and command lines (`Run: …`, `then run …`, `$ …`).
 *
 * Each source becomes one masked script per language: every line that holds no snippet of that
 * language is blank, so a rule's line number is the source's own line. Pure, linear in the text,
 * and bounded: each source is read to 1 MiB, at most 8,192 snippets per source and 1 MiB of
 * snippet text per entry. The caps fail closed (§8): a source a cap cut short is blocked by
 * `instructionTruncations`, never passed on what was read. Ordinary docs sit far under them.
 *
 * Prose tells an agent to run things too ("pipe the output of curl … into bash", "decode this and
 * run it"). `instructionTruncations` also reads every source's prose for execution intent and
 * holds what no code-shaped command carries, since no rule can prove it safe.
 */

/** One masked script from an instruction source, its lines aligned with the source's. */
export interface InstructionScript {
  path: string;
  language: ScriptLanguage;
  text: string;
}

const MAX_SOURCE_CHARS = 1024 * 1024;
const MAX_SNIPPETS = 8192;
const MAX_ENTRY_CHARS = 1024 * 1024;

/** The files an agent reads as instructions. */
export const instructionFile =
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

/** One instruction source: its path, its text to the cap, and whether the cap cut it. */
interface Source {
  path: string;
  text: string;
  /** The script rules already read its whole text, so only inline commands are extracted. */
  whole: boolean;
  /** The text was longer than {@link MAX_SOURCE_CHARS}; what's past it went unread. */
  cut: boolean;
}

/** Every instruction source of `input`. */
function sourcesOf(
  input: ScanInput,
  readWhole: (path: string, source: string) => boolean,
): Source[] {
  const out: Source[] = [];
  const add = (path: string, text: string, whole = false) =>
    out.push({
      path,
      text: text.slice(0, MAX_SOURCE_CHARS),
      whole,
      cut: text.length > MAX_SOURCE_CHARS,
    });
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
function snippetsOf(text: string, whole: boolean): { snippets: Snippet[]; stoppedAt?: number } {
  const snippets: Snippet[] = [];
  const lines = text.split("\n");
  let fence: { marker: string; language: ScriptLanguage; session: boolean } | undefined;
  let inIndented = false;
  for (let index = 0; index < lines.length; index++) {
    // The cap stops the loop only with lines left, and says where (fail closed, §8).
    if (snippets.length >= MAX_SNIPPETS) return { snippets, stoppedAt: index };
    const line = lines[index] ?? "";
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
  return { snippets };
}

/**
 * The masked scripts of every instruction source of `input`. `readWhole` says whether the script
 * rules already read a file's whole text (a plugin's README does; a skill's SKILL.md doesn't).
 */
export function instructionScripts(
  input: ScanInput,
  readWhole: (path: string, source: string) => boolean,
): InstructionScript[] {
  return extract(sourcesOf(input, readWhole)).scripts;
}

/** Where a cap stopped extraction short: a source and, when it has one, the line. */
interface Cut {
  path: string;
  line?: number;
  message: string;
}

/** The masked scripts of `sources`, and every place a cap cut extraction short. */
function extract(sources: readonly Source[]): { scripts: InstructionScript[]; cuts: Cut[] } {
  const scripts: InstructionScript[] = [];
  const cuts: Cut[] = [];
  let budget = MAX_ENTRY_CHARS;
  for (const source of sources) {
    if (source.cut)
      cuts.push({
        path: source.path,
        message: `${source.path} has more instruction text than the scanner reads`,
      });
    const { snippets, stoppedAt } = snippetsOf(source.text, source.whole);
    if (stoppedAt !== undefined)
      cuts.push({
        path: source.path,
        line: stoppedAt + 1,
        message: `${source.path} has more commands than the scanner reads; the rest went unread`,
      });
    if (snippets.length === 0) continue;
    const lineCount = (snippets.at(-1)?.line ?? 0) + 1;
    const masked = new Map<ScriptLanguage, string[]>();
    for (const snippet of snippets) {
      if (snippet.text.length > budget) {
        cuts.push({
          path: source.path,
          line: snippet.line + 1,
          message: `${source.path} has more command text than the scanner reads for one entry`,
        });
        budget = 0;
        break;
      }
      const text = snippet.text;
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
  return { scripts, cuts };
}

/**
 * The fail-closed findings of an entry's instructions (ADR 0173 §8): a `scan-truncated` block
 * for every source a cap cut short, and a hold for prose that tells an agent to run something
 * no code-shaped command carries.
 *
 * Truncation is measured with every source's blocks extracted (as if no script rule read any
 * file whole), which extracts at least what {@link instructionScripts} does, so a cap that cuts
 * the real extraction always cuts this one too.
 */
export function instructionTruncations(input: ScanInput): MarketScanFinding[] {
  const sources = sourcesOf(input, () => false);
  const findings = extract(sources).cuts.map((cut) =>
    truncated("scripts", cut.message, cut.path, cut.line),
  );
  for (const source of sources) findings.push(...intentFindings(source.path, source.text));
  return findings;
}

/*
 * Execution intent in prose. A sentence holds when it pairs a run verb with something to run
 * that isn't a code-shaped command: a pipe into an interpreter, a decode, an encoded blob, a
 * download, or a URL with an interpreter or "it". Code blocks and inline commands are left out,
 * since the script rules read them; a sentence that only mentions a tool ("helps you run
 * reports") has nothing to run and stays clean. Linear: each sentence is read once, and a run of
 * prose with no sentence end is cut into windows of {@link MAX_SENTENCE_CHARS}.
 */

const MAX_SENTENCE_CHARS = 2000;
const MAX_INTENT_FINDINGS = 16;

const interpreters =
  "sh|bash|zsh|ksh|dash|fish|python[23]?|node(?:js)?|deno|bun|ruby|perl|php|pwsh|powershell|osascript|cmd(?:\\.exe)?|iex|invoke-expression";
const runVerb =
  /\b(?:run|runs|running|ran|execute[sd]?|executing|exec|eval|evaluate|pipe[sd]?|piping)\b/i;
const fetchVerb = /\b(?:download(?:s|ed|ing)?|fetch(?:es|ed|ing)?|curl|wget|grab|retrieve)\b/i;
const decodeVerb = /\b(?:decode[sd]?|decoding|base-?64|unhex|deobfuscate|decrypt|uudecode)\b/i;
const interpreter = new RegExp(`\\b(?:${interpreters})\\b`, "i");
const pipeInto = new RegExp(
  `\\b(?:pipe[sd]?|piping|feed|feeding|redirect)\\b.{0,200}?\\b(?:into|to|through|with)\\s+(?:an?\\s+|the\\s+|your\\s+)?(?:shell|interpreter|terminal|${interpreters})\\b`,
  "i",
);
const runIt =
  /\b(?:run|execute|exec|eval|source|launch)\s+(?:it|that|this|them|the\s+(?:result|output|script|file|installer|binary|payload|blob|string|command))\b/i;
const urlLike = /\bhttps?:\/\/\S|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\/\S/i;
const base64Run = /[A-Za-z0-9+/]{24,}={0,2}/g;
const hexRun = /\b(?:0x)?[0-9a-f]{16,}\b/i;
const sentenceEnd = /(?<=[.!?])\s+/;

/** Whether `text` holds a long base64 run (mixed letters and digits) or a hex run. */
function hasBlob(text: string): boolean {
  if (hexRun.test(text)) return true;
  for (const match of text.matchAll(base64Run)) {
    const run = match[0];
    if (/\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/** Whether a prose sentence tells an agent to run something it doesn't spell out as code. */
export function hasExecutionIntent(sentence: string): boolean {
  if (pipeInto.test(sentence)) return true;
  if (!runVerb.test(sentence)) return false;
  if (decodeVerb.test(sentence) || hasBlob(sentence)) return true;
  const it = runIt.test(sentence);
  const interp = interpreter.test(sentence);
  const url = urlLike.test(sentence);
  if (fetchVerb.test(sentence) && (it || interp || url)) return true;
  return url && (interp || it);
}

/** The prose of `text` as sentences with their 1-based start lines; code is left out. */
function proseSentences(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let buffer = "";
  let start = 0;
  const flush = () => {
    if (!blank.test(buffer)) out.push({ line: start, text: buffer });
    buffer = "";
  };
  const lines = text.split("\n");
  let fence: string | undefined;
  let inIndented = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (fence !== undefined) {
      const trimmed = line.trim();
      if (trimmed.startsWith(fence) && /^(`+|~+)$/.test(trimmed)) fence = undefined;
      continue;
    }
    const open = fenceOpen.exec(line);
    if (open) {
      flush();
      fence = open[1] ?? "```";
      inIndented = false;
      continue;
    }
    const previousBlank = index === 0 || blank.test(lines[index - 1] ?? "");
    if (indented.test(line) && !blank.test(line) && (inIndented || previousBlank)) {
      flush();
      inIndented = true;
      continue;
    }
    if (blank.test(line)) {
      flush();
      continue;
    }
    inIndented = false;
    // An inline command is read by the script rules; the words around it are read here.
    const prose = line.replace(inlineSpan, (_match, span: string) =>
      commandLike.test(span.trim()) ? " " : span,
    );
    const pieces = prose.split(sentenceEnd);
    for (const [order, piece] of pieces.entries()) {
      if (buffer === "") start = index + 1;
      buffer = buffer === "" ? piece : `${buffer} ${piece}`;
      if (order < pieces.length - 1 || buffer.length >= MAX_SENTENCE_CHARS) flush();
    }
  }
  flush();
  return out;
}

/** A hold for each prose sentence of a source that tells an agent to run something. */
function intentFindings(path: string, text: string): MarketScanFinding[] {
  const findings: MarketScanFinding[] = [];
  for (const sentence of proseSentences(text)) {
    if (findings.length >= MAX_INTENT_FINDINGS) break;
    if (hasExecutionIntent(sentence.text))
      findings.push(
        held(
          "scripts",
          "instruction-intent",
          `${path} tells an agent to run something the scanner can't tie to a known-safe command`,
          path,
          sentence.line,
        ),
      );
  }
  return findings;
}
