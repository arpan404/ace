import { win32 } from "node:path";

/**
 * Windows: one word of a configured hook command. Git runs a command holding shell characters
 * through its MSYS sh, and runs a plain one directly, so a word is read both ways.
 */
export interface HookWord {
  /** The word after sh removes its quotes and backslashes. */
  shell: string;
  /** The word with quotes removed and every backslash kept, as a Windows path is written. */
  literal: string;
  /** sh would expand it (a variable, command substitution or glob): what it names is unknown. */
  expands: boolean;
}

const blanks = new Set([" ", "\t", "\n", "\r"]);
const operators = new Set([";", "&", "|", "<", ">", "(", ")"]);
const globs = new Set(["*", "?", "["]);
/** Characters a backslash escapes inside double quotes; before any other it stays. */
const quotedEscapes = new Set(["$", "`", '"', "\\", "\n"]);
const expansion = /^[\w{(@*#?$!-]/;

/** Windows: the words of a hook command, split as sh splits them. */
export function hookCommandWords(command: string): HookWord[] {
  const words: HookWord[] = [];
  let word: HookWord | undefined;
  let quote: "'" | '"' | undefined;
  const current = () => (word ??= { shell: "", literal: "", expands: false });
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    const next = command.charAt(index + 1);
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else append(current(), char, char);
      continue;
    }
    if (char === "\\") {
      if (next === "" || (quote === '"' && !quotedEscapes.has(next))) {
        append(current(), char, char);
        continue;
      }
      index += 1;
      append(current(), next === "\n" ? "" : next, char + next);
      continue;
    }
    if (char === "`" || (char === "$" && expansion.test(next))) current().expands = true;
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else append(current(), char, char);
      continue;
    }
    if (blanks.has(char) || operators.has(char)) {
      if (word) words.push(word);
      word = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      current();
      quote = char;
      continue;
    }
    if (globs.has(char)) current().expands = true;
    append(current(), char, char);
  }
  if (word) words.push(word);
  return words;
}

function append(word: HookWord, shell: string, literal: string) {
  word.shell += shell;
  word.literal += literal;
}

/** A word that may name a file: it holds a separator or starts at a home directory. */
export const namesPath = (word: HookWord) =>
  /[\\/]/.test(word.shell) || /[\\/]/.test(word.literal) || word.shell.startsWith("~");

/** What Git for Windows' sh needs to read a rooted or `~` path. */
export interface ShellLayout {
  /** The Git for Windows installation, the MSYS root `/` (from `git --exec-path`). */
  install?: string | undefined;
  /** The home directory `~` names, as Git expands it. */
  home?: string | undefined;
}

/**
 * Every place `word` may name when Git runs a hook in `top`: as Windows reads it, and as Git's
 * MSYS sh does (`/c/...`, mounts under the installation, `~`). Undefined when it can't be told.
 */
export function wordPaths(word: string, top: string, layout: ShellLayout): string[] | undefined {
  const paths = [win32.resolve(top, word)];
  if (word.startsWith("~")) {
    if (!/^~(?:[\\/]|$)/.test(word) || !layout.home) return undefined;
    return [...paths, win32.join(layout.home, word.slice(1))];
  }
  const msys = msysPaths(word, layout.install);
  return msys ? [...paths, ...msys] : undefined;
}

/** A rooted word that only the installation can place (not `/c/...` or a UNC path). */
export const needsInstall = (word: string) =>
  word.startsWith("/") && !word.startsWith("//") && !/^\/[a-z](?:[\\/]|$)/i.test(word);

/**
 * Where MSYS may read a `/`-rooted path: `/c/...` as drive C:, and under the installation
 * (`/bin` and `/lib` are mounts of `/usr/...`). `/cygdrive/c/...` is read both ways too. `/tmp`
 * is the user's temporary folder, which isn't known here. A UNC `//host/...` path, or one not
 * rooted at `/`, has no MSYS reading.
 */
export function msysPaths(word: string, install: string | undefined): string[] | undefined {
  if (!word.startsWith("/") || word.startsWith("//")) return [];
  if (/^\/tmp(?:[\\/]|$)/i.test(word)) return undefined;
  const drive = /^\/(?:cygdrive\/)?([a-z])(?=[\\/]|$)(.*)$/i.exec(word);
  const paths = drive ? [win32.resolve(`${drive[1] ?? ""}:\\`, `.${drive[2] ?? ""}`)] : [];
  if (!install) return drive ? paths : undefined;
  const mounted = word.replace(/^\/(bin|lib)(?=[\\/]|$)/i, "/usr/$1");
  return [...paths, win32.join(install, mounted)];
}

/** The Git for Windows installation from `git --exec-path` (`<install>/<arch>/libexec/git-core`). */
export function gitInstall(execPath: string): string | undefined {
  const match = /^(.*)[\\/](?:[^\\/]+)[\\/]libexec[\\/]git-core[\\/]?$/i.exec(execPath.trim());
  return match?.[1] ? win32.resolve(match[1]) : undefined;
}
