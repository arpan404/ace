/*
 * A TypeScript port of Spade's shell reader (`spade_core::autonomy::shell::parse`, ADR 0171), for
 * the scanner (ADR 0173 §8). It reads a command into simple commands: words with quoting and
 * escapes undone, pipes, `$(…)`, `sh -c` strings and the wrappers that run another command
 * (`env`, `sudo`, `nohup`, `xargs`, `timeout`, `exec`, `command`, `nice`…) unwrapped to what they
 * run, with `${IFS}` and empty quotes folded first, so `c''url ${IFS}x|b\ash` reads as
 * `curl x | bash`. A multi-call binary (`busybox sh x`, `toybox wget …`) reads as its applet, and
 * a program it can't resolve that is handed an interpreter or a script (`./runner bash x`) is
 * marked unreadable, so it is held, never passed (ADR 0173 §8, fail closed). Backticks, process substitution `<(…)` and anything else it can't read for
 * sure leave the whole command `unreadable`, which is itself a finding the rules act on. Pure.
 *
 * Ported from our own code; the implementation is written fresh here. It keeps the parser's
 * design, not its exact Rust shape: the scanner needs which programs run with which words, their
 * redirects and pipes, and whether reading gave up, nothing more.
 */

/** One simple command the reader found: its words (wrappers taken off) and its redirects. */
export interface Simple {
  /** The program and its arguments, quoting and escapes undone, wrappers removed. */
  words: string[];
  /** Its input is the previous command's output. */
  piped: boolean;
  /** Files its output is written to (`> file`, `>> file`, `&> file`). */
  writesTo: string[];
  /** Files its input comes from (`< file`). */
  readsFrom: string[];
  /** The 1-based source line where the command begins. */
  line: number;
}

/** The reader's answer: the simple commands, and whether some text could not be read for sure. */
export interface ReadShell {
  commands: Simple[];
  unreadable: boolean;
}

const DEEPEST = 4;

/** Shell keywords that can stand before a command, or close a compound one. */
const KEYWORDS = new Set([
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "esac",
  "case",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh"]);
const INTERPRETERS = new Set([
  ...SHELLS,
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "lua",
  "osascript",
  "awk",
  "gawk",
  "mawk",
  "nawk",
]);

/** A lookup table keyed by command name: a Map, so inherited names (`constructor`) never match. */
const mapOf = (table: Record<string, string[]>): ReadonlyMap<string, string[]> =>
  new Map(Object.entries(table));

/** Wrappers that run the command after them, with the flags of each that take a value. */
const WRAPPERS: ReadonlyMap<string, string[]> = mapOf({
  env: ["-u", "-C", "--unset", "--chdir"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  time: ["-f", "-o", "--format", "--output"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "--class", "--classdata"],
  stdbuf: ["-i", "-o", "-e"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  caffeinate: ["-t", "-w"],
  xargs: [
    "-I",
    "-n",
    "-P",
    "-L",
    "-d",
    "-E",
    "-s",
    "-a",
    "--max-args",
    "--max-procs",
    "--delimiter",
    "--arg-file",
  ],
  setsid: [],
  unbuffer: [],
  chronic: [],
  torsocks: [],
  strace: ["-o", "-e", "-p", "-s", "-u"],
  ltrace: ["-o", "-e", "-p", "-s", "-u"],
  chrt: [],
  taskset: [],
});

/**
 * Wrappers that run the command after them with other rights: kept as their own one-word command
 * (so a rule can see the elevation), and unwrapped, so what they run is read too. Flags that take
 * a value are listed so the command that follows is found.
 */
const ELEVATE: ReadonlyMap<string, string[]> = mapOf({
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group"],
  doas: ["-u", "-C"],
  pkexec: ["--user"],
  runuser: ["-u", "-g", "-G", "--user", "--group"],
  su: ["-s", "-g", "-G", "--shell", "--group"],
});

/**
 * Multi-call binaries that run the applet named by their first argument (`busybox sh x` is
 * `sh x`, `toybox wget …` is `wget …`). The applet is read as the program, so every rule sees the
 * real interpreter or fetcher. `busybox` alone, or with only its own flags, is kept as it is.
 */
const MULTI_CALL = /^(?:busybox|toybox)(?:[.-][a-z0-9]+)?$/;

/**
 * Programs whose arguments are data, never a command they run: a word like `sh` or a path to a
 * script after one of them is an argument, not a wrapped command. Outside this list (and the
 * known interpreters and wrappers), a program handed an interpreter or a script is a wrapper the
 * reader can't resolve, and is held (ADR 0173 §8, fail closed).
 */
const LEAVES = new Set(
  [
    "echo printf cat tac less more head tail ls grep egrep fgrep rg ag cp mv rm ln mkdir",
    "rmdir touch chmod chown chgrp install stat file wc sort uniq cut tr sed diff cmp tee",
    "test [ [[ which type whereis hash basename dirname realpath readlink du df tar zip unzip",
    "gzip gunzip md5sum sha256sum shasum shellcheck shfmt man info help cd pushd popd pwd",
    "export unset alias read set local declare readonly return exit true false trap wait kill",
    "pkill killall pgrep ps git vi vim nvim nano code open mktemp date sleep seq yes id",
    "whoami uname hostname brew apt apt-get dnf yum pacman curl wget aria2c http https",
  ]
    .join(" ")
    .split(" "),
);

/** Extensions of files a program may run as a script. */
const SCRIPT_PATH =
  /\.(?:sh|bash|zsh|ksh|dash|py|pyw|js|mjs|cjs|ts|rb|pl|php|lua|ps1|command|applescript)$/i;
/** Places a dropped payload usually lives: any path there is treated as a script. */
const DROP_DIR = /^(?:\/tmp|\/var\/tmp|\/dev\/shm|\/private\/tmp)\//;

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  const name = slash < 0 ? word : word.slice(slash + 1);
  return name.toLowerCase();
}

function isAssignment(word: string): boolean {
  const eq = word.indexOf("=");
  if (eq <= 0) return false;
  const name = word.slice(0, eq);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * `${IFS}` and other `${…}` word-splitting tricks, and empty quotes, folded before tokenising, as
 * Spade's reader does, so a command spaced out with `${IFS}` reads with its words apart. `${IFS}`
 * (and `$IFS`) become a space; an empty `${X}`/`$X`-less construct is dropped. Everything else is
 * left for the tokeniser to undo.
 */
function foldIfs(text: string): string {
  return text
    .replaceAll(/\$\{IFS\}/g, " ")
    .replaceAll(/\$IFS\b/g, " ")
    .replaceAll(/\$\{IFS:-[^}]*\}/g, " ");
}

/** The recovery flag threaded through the reader: set once some text could not be read for sure. */
interface Ctx {
  unreadable: boolean;
}

/** The inner text of a `$(…)` and the index after its `)`; `dollar` is the index of the `$`. */
function substitution(chars: string[], dollar: number, ctx: Ctx): { inner: string; end: number } {
  const from = dollar + 2; // past '$('
  let depth = 1;
  for (let i = from; i < chars.length; i++) {
    if (chars[i] === "(") depth++;
    else if (chars[i] === ")") {
      depth--;
      if (depth === 0) return { inner: chars.slice(from, i).join(""), end: i + 1 };
    }
  }
  // An unbalanced `$(` can't be read for sure; take the rest as its text and flag it.
  ctx.unreadable = true;
  return { inner: chars.slice(from).join(""), end: chars.length };
}

/**
 * The simple commands of one `text`, at nesting `depth`. It never discards a command it could
 * read: when it meets text it can't read for sure (an unterminated quote, a backtick, `<(…)`, a
 * dangling redirect, or nesting past {@link DEEPEST}) it sets `ctx.unreadable` and reads on, so a
 * pipeline like `curl … | sh` still comes back as its two commands.
 */
function parse(text: string, depth: number, ctx: Ctx): Simple[] {
  if (depth > DEEPEST) {
    ctx.unreadable = true;
    return [];
  }
  const chars = Array.from(foldIfs(text));
  const out: Simple[] = [];
  // Commands inside `$(…)`: they run, so they are read and appended to the result.
  const nested: Simple[] = [];
  let line = 1;
  let current: Simple = { words: [], piped: false, writesTo: [], readsFrom: [], line };
  let word = "";
  let wordLine = 1;
  let inWord = false;
  let target = false;
  let input = false;
  let i = 0;

  const endWord = () => {
    if (!inWord) return;
    const taken = word;
    word = "";
    inWord = false;
    if (target) {
      current.writesTo.push(taken);
      target = false;
    } else if (input) {
      current.readsFrom.push(taken);
      input = false;
    } else {
      if (current.words.length === 0) current.line = wordLine;
      current.words.push(taken);
    }
  };
  const breakCommand = (piped: boolean) => {
    endWord();
    if (target || input) {
      ctx.unreadable = true;
      target = false;
      input = false;
    }
    out.push(current);
    current = { words: [], piped, writesTo: [], readsFrom: [], line };
  };

  while (i < chars.length) {
    const c = chars[i];
    if (!inWord) wordLine = line;
    if (c === "\n") line++;
    if (c === " " || c === "\t") {
      endWord();
    } else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      if (c === "&" && chars[i + 1] === ">") {
        endWord();
        i++;
        if (chars[i + 1] === ">") i++;
        target = true;
        i++;
        continue;
      }
      const piped = c === "|" && chars[i + 1] !== "|";
      if ((c === "&" || c === "|") && chars[i + 1] === c) i++;
      breakCommand(piped);
    } else if (c === "'") {
      inWord = true;
      i++;
      for (;;) {
        const ch = chars[i];
        if (ch === undefined) {
          ctx.unreadable = true;
          break;
        }
        if (ch === "'") break;
        word += ch;
        i++;
      }
    } else if (c === '"') {
      inWord = true;
      i++;
      for (;;) {
        const ch = chars[i];
        if (ch === undefined) {
          ctx.unreadable = true;
          break;
        }
        if (ch === '"') break;
        if (ch === "`") {
          // A backtick substitution can't be read for sure; keep the char and read on.
          ctx.unreadable = true;
          word += ch;
        } else if (ch === "\\") {
          i++;
          const next = chars[i];
          if (next === undefined) {
            ctx.unreadable = true;
            break;
          }
          word += next;
        } else if (ch === "$" && chars[i + 1] === "(") {
          const sub = substitution(chars, i, ctx);
          for (const command of parse(sub.inner, depth + 1, ctx)) nested.push(command);
          word += "$SUB";
          i = sub.end;
          continue;
        } else {
          word += ch;
        }
        i++;
      }
    } else if (c === "`") {
      // A backtick substitution: flag it, keep the char, and read on.
      ctx.unreadable = true;
      inWord = true;
      word += c;
    } else if (c === "\\") {
      inWord = true;
      i++;
      const ch = chars[i];
      if (ch !== undefined && ch !== "\n") word += ch;
    } else if (c === "$" && chars[i + 1] === "(") {
      const sub = substitution(chars, i, ctx);
      for (const command of parse(sub.inner, depth + 1, ctx)) nested.push(command);
      inWord = true;
      word += "$SUB";
      i = sub.end;
      continue;
    } else if (c === "<" && chars[i + 1] === "(") {
      // Process substitution runs a command the reader can't follow; flag it and read its
      // inner command as a subshell by stepping over the `<`.
      ctx.unreadable = true;
      i++;
      continue;
    } else if (c === "<") {
      endWord();
      input = true;
    } else if (c === ">") {
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      if (chars[i + 1] === "(") {
        ctx.unreadable = true;
        i++;
        continue;
      }
      if (chars[i + 1] === ">" || chars[i + 1] === "|") i++;
      if (chars[i + 1] === "&") {
        i += 2;
        while (chars[i] !== undefined && (/\d/.test(chars[i] ?? "") || chars[i] === "-")) i++;
        continue;
      }
      target = true;
    } else if (c === "#" && !inWord) {
      while (i < chars.length && chars[i] !== "\n") i++;
      continue;
    } else {
      inWord = true;
      word += c;
    }
    i++;
  }
  endWord();
  if (target || input) ctx.unreadable = true;
  out.push(current);

  const simple: Simple[] = [];
  for (const command of out) {
    if (command.words.length === 0 && command.writesTo.length === 0) continue;
    for (const unwrapped of unwrap(command, depth, ctx)) simple.push(unwrapped);
  }
  for (const command of nested) simple.push(command);
  return simple;
}

/** The value given to `flag` (`-c x`, `--flag=x`), if any. */
function valueOf(words: string[], flag: string): string | undefined {
  for (let at = 0; at < words.length; at++) {
    const w = words[at];
    if (w === flag) return words[at + 1];
    if (flag.startsWith("--") && w?.startsWith(`${flag}=`)) return w.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * What `env -S 'string' args…` runs: the string split into words, then the words after it, each
 * kept as one word. Undefined when `words` has no `-S`.
 */
function splitString(words: string[]): string | undefined {
  for (let at = 0; at < words.length; at++) {
    const w = words[at] ?? "";
    let script: string | undefined;
    let rest = at + 1;
    if (w === "-S" || w === "--split-string") {
      script = words[at + 1];
      rest = at + 2;
    } else if (w.startsWith("--split-string=")) script = w.slice("--split-string=".length);
    if (script === undefined) continue;
    const after = words.slice(rest).map((word) => `'${word.replaceAll("'", "'\\''")}'`);
    return [script, ...after].join(" ");
  }
  return undefined;
}

/** Takes off `flags` (and the value of each in `valued`) from the front of `words`. */
function stripFlags(words: string[], valued: string[]): void {
  while (words.length > 0) {
    const w = words[0] ?? "";
    if (w === "--") {
      words.shift();
      return;
    }
    if (!w.startsWith("-") && !isAssignment(w)) return;
    const takes = valued.includes(w);
    words.shift();
    if (takes && words.length > 0) words.shift();
  }
}

/** A command the string `parent` runs (`sh -c`, `su -c`): it inherits the pipe and line of `parent`. */
function adopt(inner: Simple[], parent: Simple): Simple[] {
  const first = inner[0];
  if (first) first.piped = first.piped || parent.piped;
  for (const command of inner) command.line = parent.line;
  return inner;
}

/**
 * Takes variable assignments and wrappers off `simple`, reads `sh -c` strings, and unwraps what
 * `sudo`, `env -S`, `xargs` and the rest run, each through the same reading.
 */
function unwrap(simple: Simple, depth: number, ctx: Ctx): Simple[] {
  if (depth > DEEPEST) {
    ctx.unreadable = true;
    return simple.words.length > 0 || simple.writesTo.length > 0 ? [simple] : [];
  }
  const out: Simple[] = [];
  for (;;) {
    const first = simple.words[0];
    if (first === undefined) {
      if (simple.writesTo.length > 0) out.push(simple);
      return out;
    }
    if (isAssignment(first) || KEYWORDS.has(first)) {
      simple.words.shift();
      continue;
    }
    if (first === "function") {
      simple.words.splice(0, Math.min(2, simple.words.length));
      continue;
    }
    const program = basename(first);

    const elevate = ELEVATE.get(program);
    if (elevate) {
      out.push({
        words: [first],
        piped: simple.piped,
        writesTo: [],
        readsFrom: [],
        line: simple.line,
      });
      simple.words.shift();
      if (program === "su") {
        const script = valueOf(simple.words, "-c") ?? valueOf(simple.words, "--command");
        if (script === undefined) return out;
        out.push(...adopt(parse(script, depth + 1, ctx), simple));
        return out;
      }
      stripFlags(simple.words, elevate);
      continue;
    }

    if (program === "command" && simple.words.some((w) => w === "-v" || w === "-V")) {
      out.push(simple);
      return out;
    }

    if (program === "env") {
      const split = splitString(simple.words);
      if (split !== undefined) {
        out.push(...adopt(parse(split, depth + 1, ctx), simple));
        return out;
      }
    }

    const wrapper = WRAPPERS.get(program);
    if (wrapper) {
      const replace =
        program === "xargs"
          ? (valueOf(simple.words, "-I") ?? valueOf(simple.words, "--replace") ?? "{}")
          : undefined;
      simple.words.shift();
      stripFlags(simple.words, wrapper);
      if (
        (program === "timeout" || program === "chrt" || program === "taskset") &&
        simple.words.length > 1
      )
        simple.words.shift();
      if (replace !== undefined) {
        const next = simple.words[0];
        if (next !== undefined && INTERPRETERS.has(basename(next))) {
          const at = simple.words
            .slice(1)
            .findIndex((w) => w === "-c" || w === "-e" || w === "-E" || w === "-r");
          const code = at < 0 ? undefined : simple.words[at + 2];
          // What xargs feeds the interpreter is its input, which the reader never sees.
          if (!(code !== undefined && !code.includes(replace) && !code.includes("{}")))
            ctx.unreadable = true;
        }
      }
      continue;
    }

    if (program === "watch") {
      simple.words.shift();
      stripFlags(simple.words, ["-n", "-d", "--interval", "-q", "--equexit"]);
      out.push(...adopt(parse(simple.words.join(" "), depth + 1, ctx), simple));
      return out;
    }

    if (SHELLS.has(program)) {
      const at = simple.words.findIndex(
        (w) => w.startsWith("-") && !w.startsWith("--") && w.includes("c"),
      );
      const script = at < 0 ? undefined : simple.words[at + 1];
      if (script !== undefined) {
        // `find -exec sh -c '{}'`: the command is a file's name, not text in the call.
        if (script.includes("{}")) {
          ctx.unreadable = true;
          out.push(simple);
          return out;
        }
        out.push(...adopt(parse(script, depth + 1, ctx), simple));
        return out;
      }
    }

    if (MULTI_CALL.test(program)) {
      // `busybox --` and the binary's own flags come before the applet; no applet, keep it.
      const rest = simple.words.slice(1);
      while (rest[0] !== undefined && rest[0].startsWith("-")) rest.shift();
      if (rest.length > 0) {
        simple.words = rest;
        continue;
      }
      out.push(simple);
      return out;
    }

    if (program === "find" && findExecRunsInterpreter(simple.words)) ctx.unreadable = true;
    else if (handsOffCommand(program, simple.words)) ctx.unreadable = true;

    // A shell or interpreter at the end of a pipe (`curl … | sh`) is an ordinary pipe to the
    // scanner: the command is kept with `piped: true`, so the view gives the previous command its
    // `pipedInto`, and nothing is marked unreadable for it.
    out.push(simple);
    return out;
  }
}

/** Whether `find … -exec`/`-execdir`/`-ok` runs an interpreter on what it finds. */
function findExecRunsInterpreter(words: readonly string[]): boolean {
  return words.some(
    (word, index) =>
      (word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir") &&
      INTERPRETERS.has(basename(words[index + 1] ?? "")),
  );
}

/**
 * Whether `words`, a command whose program is no interpreter, wrapper or known leaf, has the
 * shape of a wrapper: its first argument past its flags is an interpreter (`runner sh x`) or a
 * script (`launcher /tmp/x.sh`). What such a program runs can't be resolved, so it is held.
 */
function handsOffCommand(program: string, words: readonly string[]): boolean {
  if (LEAVES.has(program) || INTERPRETERS.has(program) || WRAPPERS.has(program)) return false;
  if (ELEVATE.has(program) || KEYWORDS.has(program)) return false;
  let at = 1;
  while (at < words.length && (words[at] ?? "").startsWith("-")) at++;
  const operand = words[at];
  if (operand === undefined) return false;
  if (INTERPRETERS.has(basename(operand)) || HANDOFF_INTERPRETERS.has(basename(operand)))
    return true;
  // A path to a script, or an extensionless file where payloads are dropped (`/tmp/x`).
  if (SCRIPT_PATH.test(operand)) return /^\.{0,2}\//.test(operand);
  return DROP_DIR.test(operand) && !/\.[A-Za-z0-9]+$/.test(basename(operand));
}

/** Interpreters outside {@link INTERPRETERS} a wrapper might be handed. */
const HANDOFF_INTERPRETERS = new Set(["python2", "pwsh", "powershell", "tclsh", "source"]);

/** Reads `command` into simple commands; `unreadable` is set when any part could not be read. */
export function readShell(command: string): ReadShell {
  const ctx: Ctx = { unreadable: false };
  const commands = parse(command, 0, ctx);
  return { commands, unreadable: ctx.unreadable };
}
