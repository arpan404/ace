/*
 * How careful to be with a shell command, from its text alone. The command line is read the way a
 * shell splits it (quotes, escapes, subshells, `$(…)`, backticks, and the scripts handed to
 * `bash -c` or `eval`), and each simple command's flags are read whatever their order or case,
 * so `rm -Rf`, `rm -fR`, `rm -r -f`, `rm --recursive --force` and `(rm -rf build)` all read the
 * same. A command line that can't be read with confidence (an unclosed quote, say) is judged by
 * plain text patterns instead, so it never reads as safer than its text suggests.
 */

export interface CommandRisk {
  level: "high" | "medium";
  text: string;
}

/** A simple command's words, after quotes and escapes. */
type Words = readonly string[];

interface Parsed {
  commands: Words[];
  /** False when something couldn't be read: the text patterns judge it instead. */
  confident: boolean;
}

interface Flags {
  short: ReadonlySet<string>;
  long: ReadonlySet<string>;
  /** Words that aren't flags, before a `--`. */
  operands: readonly string[];
}

/** Scripts inside scripts deeper than this aren't read: the text patterns judge them. */
const maxDepth = 6;

/**
 * The text of a `$(…)` starting just after its `$(`, and where it ends; undefined when it never
 * closes. Quotes inside it don't count its parentheses.
 */
function substitution(text: string, start: number): { inner: string; end: number } | undefined {
  let depth = 1;
  let quote: string | undefined;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = undefined;
    } else if (char === "\\") index++;
    else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return { inner: text.slice(start, index), end: index };
  }
  return undefined;
}

/** The text of a backtick substitution starting just after its backtick, and where it ends. */
function backticks(text: string, start: number): { inner: string; end: number } | undefined {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "`") return { inner: text.slice(start, index), end: index };
  }
  return undefined;
}

/**
 * Splits a command line into simple commands: on `;`, `&`, `|`, newlines and the parentheses of
 * a subshell. Quotes and escapes group words; `$(…)` and backtick substitutions are read as
 * command lines of their own.
 */
function parse(script: string, depth: number): Parsed {
  if (depth > maxDepth) return { commands: [], confident: false };
  const commands: Words[] = [];
  const nested: string[] = [];
  let confident = true;
  let words: string[] = [];
  let word = "";
  let started = false;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const add = (text: string) => {
    word += text;
    started = true;
  };
  for (let index = 0; index < script.length; index++) {
    const char = script[index] ?? "";
    const next = script[index + 1];
    if (char === "\\") {
      // An escaped newline continues the line; any other escaped character is itself.
      if (next !== undefined && next !== "\n") add(next);
      index++;
    } else if (char === "'") {
      const end = script.indexOf("'", index + 1);
      if (end < 0) return { commands, confident: false };
      add(script.slice(index + 1, end));
      index = end;
    } else if (char === '"') {
      let closed = false;
      let text = "";
      for (index++; index < script.length; index++) {
        const inner = script[index] ?? "";
        if (inner === "\\" && index + 1 < script.length) {
          text += script[++index];
        } else if (inner === '"') {
          closed = true;
          break;
        } else if (inner === "$" && script[index + 1] === "(") {
          const found = substitution(script, index + 2);
          if (!found) return { commands, confident: false };
          nested.push(found.inner);
          index = found.end;
        } else if (inner === "`") {
          const found = backticks(script, index + 1);
          if (!found) return { commands, confident: false };
          nested.push(found.inner);
          index = found.end;
        } else text += inner;
      }
      if (!closed) return { commands, confident: false };
      add(text);
    } else if (char === "$" && next === "(") {
      const found = substitution(script, index + 2);
      if (!found) return { commands, confident: false };
      nested.push(found.inner);
      index = found.end;
      started = true;
    } else if (char === "`") {
      const found = backticks(script, index + 1);
      if (!found) return { commands, confident: false };
      nested.push(found.inner);
      index = found.end;
      started = true;
    } else if (char === "#" && !started) {
      // A comment runs to the end of the line.
      const end = script.indexOf("\n", index);
      index = end < 0 ? script.length : end - 1;
    } else if (";&|\n()".includes(char)) endCommand();
    else if (char === "<" || char === ">" || /\s/.test(char)) endWord();
    else add(char);
  }
  endCommand();
  for (const inner of nested) {
    const read = parse(inner, depth + 1);
    commands.push(...read.commands);
    confident &&= read.confident;
  }
  // Scripts handed to a shell (`bash -c '…'`, `eval …`) are command lines too.
  const handed = commands.flatMap(handedScripts);
  for (const text of handed) {
    const read = parse(text, depth + 1);
    commands.push(...read.commands);
    confident &&= read.confident;
  }
  return { commands, confident };
}

/** The program a word names, by name or by path (`/bin/rm`). */
const programName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** The scripts a simple command hands to a shell: `bash -c '…'`, `sh -lc "…"`, `eval …`. */
function handedScripts(command: Words): string[] {
  const scripts: string[] = [];
  command.forEach((word, index) => {
    const name = programName(word);
    if (name === "eval") scripts.push(command.slice(index + 1).join(" "));
    if (!shells.has(name)) return;
    // Its options come first; `-c` (alone or in a cluster such as `-lc`) takes the script next.
    for (let at = index + 1; at < command.length; at++) {
      const option = command[at] ?? "";
      if (!option.startsWith("-")) return;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option)) {
        const script = command[at + 1];
        if (script !== undefined) scripts.push(script);
        return;
      }
    }
  });
  return scripts;
}

/** The short-flag letters, long-flag names and operands in `words`; `--` ends the flags. */
function flagsOf(words: Words): Flags {
  const short = new Set<string>();
  const long = new Set<string>();
  const operands: string[] = [];
  for (const word of words) {
    if (word === "--") break;
    if (word.startsWith("--")) long.add(word.slice(2).split("=")[0] ?? "");
    else if (word.startsWith("-") && word.length > 1)
      for (const letter of word.slice(1)) short.add(letter);
    else operands.push(word);
  }
  return { short, long, operands };
}

/**
 * Every place in a simple command where `program` starts, with the words after it. Looking at
 * every word, not only the first, keeps commands run through `sudo`, `env`, `xargs`, `ssh` or
 * `docker exec` in view.
 */
function invocations(command: Words, program: string): Words[] {
  const found: Words[] = [];
  command.forEach((word, index) => {
    if (programName(word) === program) found.push(command.slice(index + 1));
  });
  return found;
}

/** Git's options that take the next word as their value (`git -C repo push`). */
const gitValueOptions = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

/** The git verb a `git` invocation runs and the words after it, past git's own options. */
function gitVerb(args: Words): { verb: string; rest: Words } | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index] ?? "";
    if (gitValueOptions.has(word)) index++;
    else if (!word.startsWith("-")) return { verb: word, rest: args.slice(index + 1) };
    else if (word === "--") return undefined;
  }
  return undefined;
}

function removesRecursivelyByForce(command: Words): boolean {
  return invocations(command, "rm").some((args) => {
    const flags = flagsOf(args);
    const recursive = flags.short.has("r") || flags.short.has("R") || flags.long.has("recursive");
    const force = flags.short.has("f") || flags.long.has("force");
    return recursive && force;
  });
}

function rewritesHistory(command: Words): boolean {
  return invocations(command, "git").some((args) => {
    const run = gitVerb(args);
    if (!run) return false;
    const flags = flagsOf(run.rest);
    switch (run.verb) {
      case "push":
        // `--force-if-includes` only narrows a force given another way; alone it does nothing.
        return (
          flags.short.has("f") ||
          flags.long.has("force") ||
          flags.long.has("force-with-lease") ||
          flags.operands.some((operand) => operand.startsWith("+"))
        );
      case "reset":
        return flags.long.has("hard");
      case "clean":
        return flags.short.has("f") || flags.long.has("force");
      default:
        return false;
    }
  });
}

function pushes(command: Words): boolean {
  return invocations(command, "git").some((args) => gitVerb(args)?.verb === "push");
}

function changesModesRecursively(command: Words): boolean {
  return invocations(command, "chmod").some((args) => {
    const flags = flagsOf(args);
    return flags.short.has("R") || flags.long.has("recursive");
  });
}

const highRiskText: readonly RegExp[] = [
  /\bsudo\b/,
  /\bdrop\s+(table|database)\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
];
/** What a command line that couldn't be read is judged by: the patterns before parsing. */
const unreadHighRiskText: readonly RegExp[] = [
  /\bgit\s+push\b.*(--force\b|--force-with-lease\b|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
  /\bchmod\s+-R\b/,
];
const mediumRiskText: readonly RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(add|install|i)\b/,
  /\b(pip|pip3|brew|cargo|gem)\s+(install|add)\b/,
  /\bgit\s+push\b/,
  /\b(curl|wget)\b/,
  /\bdocker\s+(run|rm|system\s+prune)\b/,
];

const high: CommandRisk = { level: "high", text: "Hard to undo." };
const medium: CommandRisk = {
  level: "medium",
  text: "It reaches the network or changes what's installed.",
};

/**
 * Only commands that rewrite history, delete recursively, escalate privileges or reach the
 * network get a level.
 */
export function commandRisk(command: string): CommandRisk | undefined {
  const { commands, confident } = parse(command, 0);
  if (
    highRiskText.some((pattern) => pattern.test(command)) ||
    (!confident && unreadHighRiskText.some((pattern) => pattern.test(command))) ||
    commands.some(
      (simple) =>
        removesRecursivelyByForce(simple) ||
        rewritesHistory(simple) ||
        changesModesRecursively(simple),
    )
  )
    return high;
  if (mediumRiskText.some((pattern) => pattern.test(command)) || commands.some(pushes))
    return medium;
  return undefined;
}
