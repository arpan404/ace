/*
 * Whether a shell command only looks around: reads a file, lists a folder or searches code, so
 * its step reads as exploration ("Explored 3 files · 2 searches") instead of "Ran a command".
 * Heuristic and conservative: any part it does not know, a redirection or a command that can
 * change something makes the whole command a plain command. Pure.
 */

export type ExploreAction = "read" | "list" | "search";

const readers = new Set(["cat", "bat", "less", "more", "nl", "head", "tail", "wc", "file", "stat"]);
const listers = new Set(["ls", "tree", "fd", "exa", "eza", "pwd", "du"]);
const searchers = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);
/** Formatting a pipeline adds: never the point of the command, never a change. */
const helpers = new Set(["head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl", "column", "cat"]);

/** Words of one simple command, quotes removed; undefined when it has a redirection. */
function words(part: string): string[] | undefined {
  const out: string[] = [];
  let word = "";
  let quote: string | undefined;
  for (let index = 0; index < part.length; index++) {
    const char = part[index] ?? "";
    if (quote) {
      // Double quotes still run `$(…)` and backticks.
      if (quote === '"' && (char === "`" || (char === "$" && part[index + 1] === "(")))
        return undefined;
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === ">" || char === "<" || char === "`" || char === "$") return undefined;
    else if (/\s/.test(char)) {
      if (word) out.push(word);
      word = "";
    } else word += char;
  }
  if (word) out.push(word);
  return out;
}

/** Split on `|`, `&&`, `||`, `&`, `;` and newlines outside quotes. */
function parts(command: string): { text: string; piped: boolean }[] {
  const out: { text: string; piped: boolean }[] = [];
  let current = "";
  let quote: string | undefined;
  let piped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    const next = command[index + 1];
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    const pair = char + (next ?? "");
    if (
      pair === "&&" ||
      pair === "||" ||
      char === ";" ||
      char === "|" ||
      char === "&" ||
      char === "\n" ||
      char === "\r"
    ) {
      out.push({ text: current, piped });
      piped = char === "|" && pair !== "||";
      current = "";
      if (pair === "&&" || pair === "||") index++;
      continue;
    }
    current += char;
  }
  out.push({ text: current, piped });
  return out.filter((part) => part.text.trim());
}

/** Options that write a file or run another program, on commands that otherwise only look. */
const unsafe: Record<string, RegExp> = {
  // Short flags combine: `sort -uo out` writes as surely as `sort -o out`.
  sort: /^(-[a-zA-Z]*o|--output)/,
  tree: /^-[a-zA-Z]*o/,
  rg: /^--pre/,
  fd: /^(-x|-X|--exec)/,
  git: /^(--output|-O|--open-files-in-pager|--ext-diff|--textconv)/,
};

function action(argv: readonly string[], piped: boolean): ExploreAction | "neutral" | undefined {
  const [name = "", ...rest] = argv;
  const program = name.split("/").at(-1) ?? name;
  if (rest.some((arg) => arg.startsWith("--output"))) return undefined;
  const risky = unsafe[program];
  if (risky && rest.some((arg) => risky.test(arg))) return undefined;
  if (program === "cd" || program === "echo" || program === "true") return "neutral";
  if (piped && helpers.has(program)) return "neutral";
  if (program === "git") {
    const sub = rest[0];
    if (sub === "grep") return "search";
    if (sub === "ls-files") return "list";
    if (sub === "show" || sub === "log" || sub === "diff" || sub === "blame") return "read";
    return undefined;
  }
  // Only `sed -n '1,80p' file`: a script of line ranges printed, nothing written or run.
  if (program === "sed")
    return rest.includes("-n") &&
      rest.some((arg) => /^(\d+|\$)?(,(\d+|\$))?p$/.test(arg)) &&
      !rest.some((arg) => /^-[a-zA-Z]*[ief]|^--(in-place|expression|file)/.test(arg))
      ? "read"
      : undefined;
  if (program === "find")
    return rest.some((arg) => /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)/.test(arg))
      ? undefined
      : "list";
  if (readers.has(program)) return "read";
  if (listers.has(program)) return "list";
  if (searchers.has(program)) return "search";
  return undefined;
}

/** What the command explores, or undefined when it is (or may be) anything else. */
export function exploreAction(command: string): ExploreAction | undefined {
  let found: ExploreAction | undefined;
  const rank = { list: 0, read: 1, search: 2 } as const;
  for (const part of parts(command)) {
    const argv = words(part.text);
    if (!argv?.length) return undefined;
    const kind = action(argv, part.piped);
    if (kind === undefined) return undefined;
    if (kind !== "neutral" && (found === undefined || rank[kind] > rank[found])) found = kind;
  }
  return found;
}
