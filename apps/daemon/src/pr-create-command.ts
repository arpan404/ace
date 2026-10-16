import { stripVTControlCharacters } from "node:util";
import { unwrapShellCommand } from "@ace/provider-kit/shell-command";
import { prFromUrl, repositoryKey } from "@ace/forge";
import type { ForgePrRef, ForgeRepository } from "@ace/protocol";

/** Recognize execution, never a gh command quoted as another command's argument. */
export function createsPullRequest(command: string): boolean {
  const sequence = splitSequence(unwrapShellCommand(command)?.inner ?? command);
  if (!sequence?.length) return false;
  const last = sequence.at(-1);
  if (!last?.length || !isGhPrCreate(last[0] ?? [])) return false;
  // Trailing pipes only shape output (tail/head/grep/cat/tee remove lines, never print a
  // foreign PR URL), so the created URL stays attributable to the gh command.
  if (!last.slice(1).every(isOutputShaping)) return false;
  // Restrict predecessors to the usual verify-and-publish flow. Printers such as echo or
  // gh pr view can print another PR URL and make output attribution ambiguous.
  return sequence.slice(0, -1).every(isSafePredecessor);
}

/** A pipeline stage that only shapes its input's lines, never prints its own PR URLs. */
function isOutputShaping(args: string[]): boolean {
  return /^(?:\/(?:[^/]+\/)*|)(?:grep|tail|head|cat|tee)$/.test(args[0] ?? "");
}

/**
 * A preceding pipeline cannot explain a bare PR URL in the output: its producer is not a
 * printer, fetcher, constructor or runner of arbitrary commands, and its tails only pass
 * lines through. Build and test runners are allowed for their fixed verbs (`bun run test`);
 * bare script execution stays out. Residual risk (a test printing a bare same-repo PR URL)
 * is documented at the call site: output attribution trusts the lone-URL line.
 */
function isSafePredecessor(stages: string[][]): boolean {
  const [first, ...rest] = stages;
  if (!first || !rest.every(isOutputShaping)) return false;
  const producer = first[0] ?? "";
  if (/^(?:\/(?:[^/]+\/)*|)(?:bun|npm|yarn|pnpm|make|just)$/.test(producer))
    return (
      ["run", "test", "exec", "x", "install", "lint", "build", "typecheck", "check", "t"].includes(
        first[1] ?? "",
      ) && first.slice(2).every((arg) => !/^(?:-e|--eval)$/.test(arg))
    );
  return !/^(?:\/(?:[^/]+\/)*|)(?:echo|printf|cat|tee|gh|curl|wget|jq|yq|xargs|ssh|scp|ftp|sftp|nc|socat|sudo|doas|su|command|exec|python|python3|node|nodejs|deno|ruby|perl|php)$/.test(
    producer,
  );
}

function isGhPrCreate(args: string[]): boolean {
  const last = args;
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(last[index] ?? "")) index++;
  if (last[index] === "env") {
    index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(last[index] ?? "")) index++;
  }
  if (last[index] === "command" || last[index] === "exec") index++;
  if (!/^(?:\/(?:[^/]+\/)*|)gh$/.test(last[index] ?? "")) return false;
  index++;
  while (last[index]?.startsWith("-")) {
    const flag = last[index++];
    if (flag === "-R" || flag === "--repo") index++;
    else if (!flag?.startsWith("--repo=")) return false;
  }
  if (last[index] !== "pr" || last[index + 1] !== "create") return false;
  for (let at = index + 2; at < last.length; at++) {
    const arg = last[at] ?? "";
    if (/^(?:--dry-run|--help)(?:=(?:true|1))?$/.test(arg) || arg === "-h") return false;
    if (
      [
        "--title",
        "-t",
        "--body",
        "-b",
        "--body-file",
        "-F",
        "--template",
        "-T",
        "--base",
        "-B",
        "--head",
        "-H",
        "--repo",
        "-R",
        "--reviewer",
        "-r",
        "--assignee",
        "-a",
        "--label",
        "-l",
        "--milestone",
        "-m",
        "--project",
        "-p",
        "--recover",
      ].includes(arg)
    )
      at++;
  }
  return true;
}

/**
 * Split a script into sequential commands (`&&`, `;`, newlines), each a pipeline of stages.
 * Output redirections (`2>&1`, `>file`) are dropped: they never print a foreign PR URL.
 * Substitutions, backticks and heredoc bodies are skipped opaquely: their text feeds arguments
 * or stdin, never output lines of their own. Anything else that changes what runs (`||`, `&`,
 * subshells, input redirects) declines rather than guessing.
 */
function splitSequence(script: string): string[][][] | undefined {
  const sequence: string[][][] = [];
  let stages: string[][] = [];
  let args: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const word = () => {
    if (started) args.push(token);
    token = "";
    started = false;
  };
  const endStage = () => {
    word();
    if (args.length) stages.push(args);
    args = [];
  };
  const endCommand = () => {
    endStage();
    if (stages.length) sequence.push(stages);
    stages = [];
  };
  // Skip an opaque region (command substitution, backticks, heredoc body): its text never
  // reaches the output stream as its own lines, so structure inside cannot start or end a
  // command. Returns the last consumed index, or undefined when unterminated.
  const skipBalanced = (at: number, open: "(" | "`"): number | undefined => {
    const close = open === "(" ? ")" : "`";
    let depth = 1;
    let i = at + 1;
    let qi: "'" | '"' | undefined;
    while (i < script.length) {
      const ch = script[i];
      if (ch === "\\" && qi !== "'") {
        i += 2;
        continue;
      }
      if (qi) {
        if (ch === qi) qi = undefined;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        qi = ch;
        i++;
        continue;
      }
      if (ch === "$" && script[i + 1] === "(") {
        const end = skipBalanced(i + 1, "(");
        if (end === undefined) return undefined;
        i = end + 1;
        continue;
      }
      if (ch === "`") {
        const end = skipBalanced(i, "`");
        if (end === undefined) return undefined;
        i = end + 1;
        continue;
      }
      if (ch === close) {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
    return undefined;
  };
  const skipHeredoc = (at: number): number | undefined => {
    let i = at + 2;
    if (script[i] === "<") return undefined;
    if (script[i] === "-") i++;
    while (script[i] === " " || script[i] === "\t") i++;
    let marker = "";
    const qc = script[i];
    if (qc === "'" || qc === '"') {
      i++;
      while (i < script.length && script[i] !== qc) {
        if (script[i] === "\\" && i + 1 < script.length) {
          marker += script[i + 1];
          i += 2;
          continue;
        }
        marker += script[i];
        i++;
      }
      if (script[i] !== qc) return undefined;
      i++;
    } else {
      while (i < script.length && /[A-Za-z0-9_]/.test(script[i] ?? "")) {
        marker += script[i];
        i++;
      }
    }
    if (!marker) return undefined;
    while (i < script.length && script[i] !== "\n") i++;
    for (;;) {
      if (i >= script.length) return undefined;
      const lineStart = i + 1;
      let eol = lineStart;
      while (eol < script.length && script[eol] !== "\n") eol++;
      // Over-consuming fails safe (a miss, never a false link): the terminator the shell
      // sees always matches here too.
      if (script.slice(lineStart, eol).trim() === marker)
        return eol < script.length ? eol : eol - 1;
      i = eol;
    }
  };
  // Consume `2>&1`, `>file`, `&>file` output redirections: the pending token, if any, is a
  // file descriptor rather than an argument, and the target never prints a foreign PR URL.
  // Anything else before `>` declines rather than guessing. Returns the last consumed index.
  const redirect = (index: number): number | undefined => {
    if (token !== "" && !/^\d+$/.test(token)) return undefined;
    token = "";
    started = false;
    let at = index + 1;
    if (script[at] === ">") at++;
    if (script[at] === "&") {
      at++;
      while (at < script.length && /\d/.test(script[at] ?? "")) at++;
      if (script[at] === "-") at++;
    } else {
      while (at < script.length && /\s/.test(script[at] ?? "")) at++;
      while (at < script.length && /[A-Za-z0-9_./~+-]/.test(script[at] ?? "")) at++;
    }
    return at - 1;
  };
  for (let index = 0; index < script.length; index++) {
    const char = script[index];
    if (char === "\\" && quote !== "'") {
      const next = script[++index];
      if (next === undefined) return undefined;
      if (next !== "\n") {
        token += next;
        started = true;
      }
    } else if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "#" && !started) {
      while (index < script.length && script[index] !== "\n") index++;
      endCommand();
    } else if (char === "$" && script[index + 1] === "(") {
      // Substitution output becomes arguments, never output lines: skip it opaquely.
      const after = skipBalanced(index + 1, "(");
      if (after === undefined) return undefined;
      index = after;
      started = true;
    } else if (char === "`") {
      const after = skipBalanced(index, "`");
      if (after === undefined) return undefined;
      index = after;
      started = true;
    } else if (char === "<" && script[index + 1] === "<") {
      // Heredoc bodies feed stdin, never the output stream: skip to the terminator.
      const after = skipHeredoc(index);
      if (after === undefined) return undefined;
      index = after;
    } else if (char === "&" && script[index + 1] === "&") {
      endCommand();
      index++;
    } else if (char === "&" && script[index + 1] === ">") {
      if (token !== "" && !/^\d+$/.test(token)) word();
      else {
        token = "";
        started = false;
      }
      const after = redirect(index + 1);
      if (after === undefined) return undefined;
      index = after;
    } else if (char === "\n" || char === ";") endCommand();
    else if (char === "|" && script[index + 1] === "|") return undefined;
    else if (char === "|") endStage();
    else if (char === ">") {
      const after = redirect(index);
      if (after === undefined) return undefined;
      index = after;
    } else if (char !== undefined && /\s/.test(char)) word();
    else if (char !== undefined && /[&<>()`$]/.test(char)) return undefined;
    else {
      token += char;
      started = true;
    }
  }
  if (quote) return undefined;
  endCommand();
  return sequence;
}

/**
 * gh prints the created PR URL on its own line. Prose and lookalike hosts are ignored. Any of
 * `repositories` may own it: the checkout's repository, or the parent a fork's PRs open on.
 */
export function createdPullRequest(
  line: string,
  repositories: readonly ForgeRepository[],
): ForgePrRef | undefined {
  const candidates = repositories.filter((repository) => repository.forge === "github");
  if (!candidates.length) return undefined;
  const text = stripVTControlCharacters(line).trim();
  if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*\/?$/.test(text)) return undefined;
  try {
    const ref = prFromUrl(
      text,
      candidates.map((repository) => repository.host),
    );
    const repository = candidates.find(
      (candidate) => repositoryKey(candidate) === repositoryKey(ref.repository),
    );
    return repository ? { ...ref, repository } : undefined;
  } catch {
    return undefined;
  }
}
