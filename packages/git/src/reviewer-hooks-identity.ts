import { realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";
import {
  gitInstall,
  hookCommandWords,
  namesPath,
  needsInstall,
  wordPaths,
  type ShellLayout,
} from "./hook-command-words.ts";

interface Output {
  stdout: Buffer;
  exitCode: number;
}
type Query = (args: string[]) => Promise<Output>;

const text = (output: Output) => output.stdout.toString("utf8").replace(/\n$/, "");

/**
 * Windows: whether a hook Git would run in the checkout at `cwd` lives inside it, decided by file
 * identity rather than by spelling. One file has many Windows names (`C:\`, `\\?\C:\`,
 * `\\localhost\C$\`, 8.3 short names, junctions, any case) and Git's sh adds MSYS ones
 * (`/c/...`), so each named path is resolved to what exists and its folders are compared, by
 * volume and file id, with the checkout's root. When a name can't be told, it counts as inside.
 */
export async function hooksInsideWindowsCheckout(query: Query, cwd: string): Promise<boolean> {
  const [hooks, top, common, commands] = await Promise.all([
    query(["rev-parse", "--git-path", "hooks"]),
    query(["rev-parse", "--path-format=absolute", "--show-toplevel"]),
    query(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    query(["config", "--null", "--get-regexp", "^hook\\..*\\.command$"]),
  ]);
  const root = win32.resolve(cwd, text(top) || cwd);
  const own = text(common);
  const [rootId, ownedId] = await Promise.all([
    identity(root),
    own ? identity(win32.resolve(cwd, own)) : undefined,
  ]);
  if (!rootId) return true;
  const words = (
    commands.exitCode === 0 ? commands.stdout.toString("utf8").split("\0").filter(Boolean) : []
  )
    .flatMap((entry) => hookCommandWords(entry.slice(entry.indexOf("\n") + 1)))
    .filter(namesPath);
  if (words.some((word) => word.expands)) return true;
  const spellings = [...new Set(words.flatMap((word) => [word.shell, word.literal]))];
  const layout = await shellLayout(query, spellings);
  // Git looks for its hooks directory as Windows reads the path (`core.hooksPath` as written).
  const candidates = [win32.resolve(cwd, text(hooks))];
  for (const spelling of spellings) {
    const paths = wordPaths(spelling, root, layout);
    if (!paths) return true;
    candidates.push(...paths);
  }
  const inside = await Promise.all(
    [...new Set(candidates)].map((path) => withinByIdentity(path, rootId, ownedId)),
  );
  return inside.some(Boolean);
}

/** The installation and home directory, asked of Git only when a word needs them. */
async function shellLayout(query: Query, spellings: string[]): Promise<ShellLayout> {
  const [install, home] = await Promise.all([
    spellings.some(needsInstall) ? query(["--exec-path"]) : undefined,
    spellings.some((spelling) => spelling.startsWith("~"))
      ? query(["-c", "ace.home=~", "config", "--type=path", "--get", "ace.home"])
      : undefined,
  ]);
  return {
    ...(install?.exitCode === 0 ? { install: gitInstall(text(install)) } : {}),
    ...(home?.exitCode === 0 && text(home) ? { home: win32.resolve(text(home)) } : {}),
  };
}

/**
 * `path`, or its nearest existing folder, lies in the folder `rootId` names and not in the one
 * `ownedId` names (the repository's own Git directory). Links are followed first, so a junction
 * in the checkout to the person's folder leads out, and one outside it into the checkout leads in.
 */
async function withinByIdentity(
  path: string,
  rootId: string,
  ownedId: string | undefined,
): Promise<boolean> {
  const real = await existingRealPath(path);
  let inside = false;
  let owned = false;
  for (let current = real; current;) {
    const id = await identity(current);
    inside ||= id === rootId;
    owned ||= ownedId !== undefined && id === ownedId;
    const parent = win32.dirname(current);
    current = parent === current ? undefined : parent;
  }
  return inside && !owned;
}

/** The real path of `path`'s longest existing prefix. */
async function existingRealPath(path: string): Promise<string | undefined> {
  for (let current = path; ;) {
    const real = await realpath(current).catch(() => undefined);
    if (real) return real;
    const parent = win32.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** A file's volume and file id; on a file system without ids, its real path in any case. */
async function identity(path: string): Promise<string | undefined> {
  const facts = await stat(path, { bigint: true }).catch(() => undefined);
  if (!facts) return undefined;
  if (facts.ino !== 0n) return `${facts.dev}:${facts.ino}`;
  const real = await realpath(path).catch(() => undefined);
  return real === undefined ? undefined : `path:${win32.resolve(real).toLowerCase()}`;
}
