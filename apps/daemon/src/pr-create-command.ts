import { stripVTControlCharacters } from "node:util";
import { unwrapShellCommand } from "@ace/provider-kit/shell-command";
import { prFromUrl, repositoryKey } from "@ace/forge";
import type { ForgePrRef, ForgeRepository } from "@ace/protocol";

/** Recognize execution, never a gh command quoted as another command's argument. */
export function createsPullRequest(command: string): boolean {
  const script = unwrapShellCommand(command)?.inner ?? command;
  const commands = shellCommands(script);
  if (!commands?.length) return false;
  const last = commands.at(-1);
  if (!last) return false;
  // Restrict prefixes to the usual publish flow. Commands such as echo or
  // gh pr view can print another PR URL and make output attribution ambiguous.
  if (commands.slice(0, -1).some((args) => !publishPrefix(args))) return false;
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

function publishPrefix(args: string[]): boolean {
  if (args[0] === "cd") return args.length === 2;
  if (!/^(?:\/(?:[^/]+\/)*|)git$/.test(args[0] ?? "")) return false;
  let index = 1;
  while (args[index] === "-C" && args[index + 1]) index += 2;
  return args[index] === "push";
}

/** This intentionally declines shell control flow and heredocs rather than guessing. */
function shellCommands(script: string): string[][] | undefined {
  const commands: string[][] = [];
  let args: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const word = () => {
    if (started) args.push(token);
    token = "";
    started = false;
  };
  const end = () => {
    word();
    if (args.length) commands.push(args);
    args = [];
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
      end();
    } else if (char === "&" && script[index + 1] === "&") {
      end();
      index++;
    } else if (char === "\n") end();
    else if (char !== undefined && /\s/.test(char)) word();
    else if (char !== undefined && /[;|&<>()`$]/.test(char)) return undefined;
    else {
      token += char;
      started = true;
    }
  }
  if (quote) return undefined;
  end();
  return commands;
}

/** gh prints the created PR URL on its own line. Prose and lookalike hosts are ignored. */
export function createdPullRequest(
  line: string,
  repository: ForgeRepository,
): ForgePrRef | undefined {
  if (repository.forge !== "github") return undefined;
  const text = stripVTControlCharacters(line).trim();
  if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*\/?$/.test(text)) return undefined;
  try {
    const ref = prFromUrl(text);
    return repositoryKey(ref.repository) === repositoryKey(repository)
      ? { ...ref, repository }
      : undefined;
  } catch {
    return undefined;
  }
}
