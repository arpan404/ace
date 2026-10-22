import { posix } from "node:path";
import type { TerminalCommand } from "../../shared/contract.ts";
import { onPath } from "./cli-shim.ts";

/**
 * How a terminal finds the `ace` command in `~/.ace/bin`. Pure: the choice between a link in
 * a folder already on PATH and a PATH line in the shell's startup file, and the text of that
 * line. `cli-path-install.ts` is the file system shell around it.
 */

/** The first and last line of the block ace adds to a shell startup file. */
const blockStart = "# >>> ace command (added by the ace app; turn off in Settings > General) >>>";
const blockEnd = "# <<< ace command <<<";
/** Every line ace writes to a file of its own (fish's `conf.d/ace.fish`) starts the file. */
export const fishMarker = "# ace command (added by the ace app; turn off in Settings > General)";

export interface CliPathFacts {
  platform: NodeJS.Platform;
  home: string;
  /** The shim's folder and file (`~/.ace/bin`, `~/.ace/bin/ace`). */
  directory: string;
  file: string;
  /** The login shell's PATH. */
  path: string;
  /** The first `ace` on that PATH, and whether it runs this app's shim (a link to it counts). */
  found?: { path: string; ours: boolean };
}

export type CliPathPlan =
  | { kind: "done"; status: TerminalCommand }
  /** Link `link` to the shim: its folder is already on PATH. */
  | { kind: "link"; link: string }
  /** Add the PATH line to the shell's startup files. */
  | { kind: "profile" };

/** The person's own `ace`, or one ace already reaches, is left as it is. */
export function planCliPath(facts: CliPathFacts): CliPathPlan {
  if (facts.found)
    return {
      kind: "done",
      status: facts.found.ours
        ? { state: "ready", command: facts.found.path }
        : { state: "other", command: facts.found.path },
    };
  if (onPath(facts.directory, facts.path, facts.platform))
    return { kind: "done", status: { state: "ready", command: facts.file } };
  if (facts.platform === "win32")
    return { kind: "done", status: { state: "manual", directory: facts.directory } };
  const link = localBin(facts.home);
  if (onPath(posix.dirname(link), facts.path, facts.platform)) return { kind: "link", link };
  return { kind: "profile" };
}

/** `~/.local/bin/ace`: on PATH by default on many Linux desktops and after many CLI installers. */
export function localBin(home: string): string {
  return posix.join(home, ".local", "bin", "ace");
}

export type StartupFile = { file: string; syntax: "sh" | "fish" };

/**
 * The startup files that set PATH for the person's shell, as `shell` names it (`$SHELL`).
 * `existing` says which of the candidate files are there. Empty for a shell whose PATH syntax
 * ace doesn't write (csh, nushell, …): the person adds the folder themselves.
 */
export function startupFiles(input: {
  shell: string;
  home: string;
  platform: NodeJS.Platform;
  env: { ZDOTDIR?: string | undefined; XDG_CONFIG_HOME?: string | undefined };
  existing(file: string): boolean;
}): StartupFile[] {
  const { home } = input;
  const at = (...parts: string[]) => posix.join(home, ...parts);
  const name = posix.basename(input.shell);
  if (name === "zsh")
    return [{ file: posix.join(input.env.ZDOTDIR || home, ".zshrc"), syntax: "sh" }];
  if (name === "fish")
    return [
      {
        file: posix.join(input.env.XDG_CONFIG_HOME || at(".config"), "fish", "conf.d", "ace.fish"),
        syntax: "fish",
      },
    ];
  if (name === "bash") {
    // Terminals on Linux start interactive shells (`.bashrc`); macOS Terminal starts login
    // shells, which read only the first of these that exists.
    const login = [at(".bash_profile"), at(".bash_login"), at(".profile")].find(input.existing);
    const files = [at(".bashrc")];
    if (login) files.push(login);
    else if (input.platform === "darwin") files.push(at(".bash_profile"));
    return files.map((file) => ({ file, syntax: "sh" }));
  }
  if (["sh", "dash", "ksh", "mksh", "ash", "yash"].includes(name))
    return [{ file: at(".profile"), syntax: "sh" }];
  return [];
}

/** Text that stays literal inside a double-quoted shell word. */
const shQuote = (value: string) => value.replace(/[\\"$`]/g, (character) => `\\${character}`);

/** A folder as a double-quoted shell word: under the home folder it is written from `$HOME`. */
function shWord(directory: string, home: string): string {
  const inside = directory.startsWith(`${home}/`) ? directory.slice(home.length + 1) : undefined;
  return inside === undefined ? `"${shQuote(directory)}"` : `"$HOME/${shQuote(inside)}"`;
}

/** The lines ace adds to a POSIX shell's startup file. A second run adds nothing to PATH. */
export function profileBlock(directory: string, home: string): string {
  const word = shWord(directory, home);
  // `${word}` without its closing quote, so the pattern reads `*":<dir>:"*`.
  const pattern = `*":${word.slice(1, -1)}:"*`;
  return [
    blockStart,
    `case ":$PATH:" in ${pattern}) ;; *) export PATH=${word}:"$PATH" ;; esac`,
    blockEnd,
  ].join("\n");
}

/** fish's `conf.d/ace.fish`, a file that is ace's alone. */
export function fishFile(directory: string): string {
  const word = `'${directory.replace(/[\\']/g, (character) => `\\${character}`)}'`;
  return [
    fishMarker,
    `if not contains -- ${word} $PATH`,
    `    set -gx PATH ${word} $PATH`,
    "end",
    "",
  ].join("\n");
}

/** Throws for a folder a startup file can't name safely. */
export function assertWritablePath(directory: string): void {
  if (/[\r\n\0]/.test(directory)) throw new Error(`Unsupported path for PATH: ${directory}`);
}

/** The file with ace's block in it once, in place of any earlier block; unchanged if current. */
export function withBlock(content: string, block: string): string {
  const range = blockRange(content);
  if (range) return content.slice(0, range.start) + block + content.slice(range.end);
  if (content === "") return `${block}\n`;
  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}\n`;
}

/** The file without ace's block and the blank line ace put before it. */
export function withoutBlock(content: string): string {
  const range = blockRange(content);
  if (!range) return content;
  const before = content.slice(0, range.start);
  const after = content.slice(range.end).replace(/^\n/, "");
  return before.replace(/\n\n$/, "\n") + after;
}

function blockRange(content: string): { start: number; end: number } | undefined {
  const start = content.indexOf(blockStart);
  if (start === -1) return undefined;
  const close = content.indexOf(blockEnd, start);
  if (close === -1) return undefined;
  return { start, end: close + blockEnd.length };
}

/** Whether this startup file already carries ace's PATH line. */
export function hasBlock(content: string): boolean {
  return blockRange(content) !== undefined;
}
