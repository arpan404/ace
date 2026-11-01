/*
 * How careful to be with a shell command, from its text alone. Flags are read per simple
 * command, so `rm -Rf`, `rm -fR`, `rm -r -f`, `rm --recursive --force` and `rm dir -rf` all
 * read the same.
 */

export interface CommandRisk {
  level: "high" | "medium";
  text: string;
}

/** A simple command's words. */
type Words = readonly string[];

interface Flags {
  short: ReadonlySet<string>;
  long: ReadonlySet<string>;
  operands: readonly string[];
}

/**
 * Splits a command line into simple commands (on `;`, `&`, `|` and newlines) and each into
 * words. Quotes group words; nothing else is interpreted.
 */
function simpleCommands(command: string): Words[] {
  const commands: Words[] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | undefined;
  const endWord = () => {
    if (word !== "") words.push(word);
    word = "";
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ";" || char === "&" || char === "|" || char === "\n") endCommand();
    else if (/\s/.test(char)) endWord();
    else word += char;
  }
  endCommand();
  return commands;
}

/** The short-flag letters, long-flag names and operands given after `start`; `--` ends flags. */
function flagsAfter(words: readonly string[], start: number): Flags {
  const short = new Set<string>();
  const long = new Set<string>();
  const operands: string[] = [];
  for (let index = start; index < words.length; index++) {
    const word = words[index] ?? "";
    if (word === "--") {
      operands.push(...words.slice(index + 1));
      break;
    }
    if (word.startsWith("--")) long.add(word.slice(2).split("=")[0] ?? "");
    else if (word.startsWith("-") && word.length > 1)
      for (const letter of word.slice(1)) short.add(letter);
    else operands.push(word);
  }
  return { short, long, operands };
}

/** Whether a word runs `program`, by name or by path (`/bin/rm`). */
function runs(word: string, program: string): boolean {
  return word === program || word.endsWith(`/${program}`);
}

/** The flags after `program`'s first word in a simple command, when it runs it. */
function programFlags(command: Words, program: string): Flags | undefined {
  const index = command.findIndex((word) => runs(word, program));
  return index < 0 ? undefined : flagsAfter(command, index + 1);
}

/** The flags after `git <subcommand>`, when the simple command runs it. */
function gitFlags(command: Words, subcommand: string): Flags | undefined {
  const git = command.findIndex((word) => runs(word, "git"));
  if (git < 0) return undefined;
  const index = command.indexOf(subcommand, git + 1);
  return index < 0 ? undefined : flagsAfter(command, index + 1);
}

function removesRecursivelyByForce(command: Words): boolean {
  const flags = programFlags(command, "rm");
  if (!flags) return false;
  const recursive = flags.short.has("r") || flags.short.has("R") || flags.long.has("recursive");
  const force = flags.short.has("f") || flags.long.has("force");
  return recursive && force;
}

function rewritesHistory(command: Words): boolean {
  const push = gitFlags(command, "push");
  if (
    push &&
    (push.short.has("f") ||
      push.long.has("force") ||
      push.long.has("force-with-lease") ||
      push.long.has("force-if-includes") ||
      push.operands.some((operand) => operand.startsWith("+")))
  )
    return true;
  if (gitFlags(command, "reset")?.long.has("hard")) return true;
  const clean = gitFlags(command, "clean");
  return clean !== undefined && (clean.short.has("f") || clean.long.has("force"));
}

function changesModesRecursively(command: Words): boolean {
  const flags = programFlags(command, "chmod");
  return flags !== undefined && (flags.short.has("R") || flags.long.has("recursive"));
}

const highRiskText: readonly RegExp[] = [
  /\bsudo\b/,
  /\bdrop\s+(table|database)\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
];
const mediumRiskText: readonly RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(add|install|i)\b/,
  /\b(pip|pip3|brew|cargo|gem)\s+(install|add)\b/,
  /\bgit\s+push\b/,
  /\b(curl|wget)\b/,
  /\bdocker\s+(run|rm|system\s+prune)\b/,
];

/**
 * Only commands that rewrite history, delete recursively, escalate privileges or reach the
 * network get a level.
 */
export function commandRisk(command: string): CommandRisk | undefined {
  const commands = simpleCommands(command);
  if (
    highRiskText.some((pattern) => pattern.test(command)) ||
    commands.some(
      (simple) =>
        removesRecursivelyByForce(simple) ||
        rewritesHistory(simple) ||
        changesModesRecursively(simple),
    )
  )
    return { level: "high", text: "Hard to undo." };
  if (mediumRiskText.some((pattern) => pattern.test(command)))
    return { level: "medium", text: "It reaches the network or changes what's installed." };
  return undefined;
}
