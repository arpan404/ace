import { isUtf8 } from "node:buffer";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { listedSources, parseLayout, watchedPaths } from "./config-sources.ts";

interface QueryOutput {
  stdout: Buffer;
  exitCode: number;
  truncated: boolean;
}
type Query = (args: string[]) => Promise<QueryOutput>;

function text(output: QueryOutput): string | undefined {
  if (output.exitCode !== 0 || output.truncated || !isUtf8(output.stdout)) return undefined;
  return output.stdout.toString("utf8");
}

/** One path value from Git: strip one LF terminator (CRLF only on Windows). */
function single(output: QueryOutput, isWindows: boolean): string | undefined {
  const full = text(output);
  if (full === undefined) return undefined;
  if (isWindows && full.endsWith("\r\n")) return full.slice(0, -2);
  if (full.endsWith("\n")) return full.slice(0, -1);
  return full;
}

/**
 * The system file and both global files (XDG, then `~/.gitconfig`) as this Git build names them,
 * present or not. Undefined on a Git too old to say (`git var` learned them in 2.42).
 * Global output is never split on LF: a single override is one path, otherwise the two are
 * accepted only when they match the environment exactly as git derives them.
 */
export async function standardConfigFiles(
  query: Query,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Promise<string[] | undefined> {
  const isWindows = platform === "win32";
  // System is a single path; ask git so build-specific locations and overrides are respected.
  const system = single(await query(["var", "GIT_CONFIG_SYSTEM"]), isWindows);
  if (system === undefined) return undefined;
  const gtext = single(await query(["var", "GIT_CONFIG_GLOBAL"]), isWindows);
  if (gtext === undefined) return undefined;
  const globals = interpretGlobal(gtext, env);
  if (globals === undefined) return undefined;
  const files = [system, ...globals].filter((file) => file !== "");
  return files.length >= 2 && files.every((file) => isAbsolute(file)) ? files : undefined;
}

/** Global files without splitting git output: single override, or XDG plus user on exact match. */
function interpretGlobal(
  gtext: string,
  env: Record<string, string | undefined>,
): string[] | undefined {
  if (env["GIT_CONFIG_GLOBAL"] !== undefined) return gtext === "" ? [] : [gtext];
  const home = env["HOME"];
  if (gtext.indexOf("\n") < 0 && gtext.indexOf("\r") < 0) return gtext === "" ? [] : [gtext];
  if (home === undefined) return undefined;
  const xdg = env["XDG_CONFIG_HOME"];
  const xdgFile =
    xdg !== undefined && xdg !== "" ? `${xdg}/git/config` : `${home}/.config/git/config`;
  const expected = `${xdgFile}\n${home}/.gitconfig`;
  return gtext === expected ? [xdgFile, `${home}/.gitconfig`] : undefined;
}

/**
 * Every file whose change could alter the configuration a Git command in `cwd` reads, asked of
 * Git itself (`rev-parse` for discovery, `config --list --show-origin` for files and includes).
 * Undefined whenever any of it can't be named exactly: then nothing is cached for `cwd`.
 */
/**
 * Where the watched-path computation can run in the core instead (G2c): the raw
 * `rev-parse`/`config --list` output is handed over unchanged.
 */
export interface RawConfigSources {
  cwd: string;
  gitDir: string | undefined;
  commonDir: string | undefined;
  toplevel: string | undefined;
  /** The listing's raw bytes, when it is valid UTF-8. */
  listing: Buffer | undefined;
  standard: string[];
  home: string | undefined;
  isWindows: boolean;
}
export type WatchConfigSources = (input: RawConfigSources) => Promise<string[] | undefined>;

export async function learnConfigSources(
  cwd: string,
  query: Query,
  standard: () => Promise<string[] | undefined>,
  home: string | undefined,
  platform: NodeJS.Platform,
  watch?: WatchConfigSources,
): Promise<string[] | undefined> {
  // A path through a symbolic link can be pointed at another checkout without any file changing.
  if ((await realpath(cwd).catch(() => undefined)) !== cwd) return undefined;
  // One path per invocation (`rev-parse` offers no NUL mode for paths): each keeps embedded
  // newlines, stripped of only its final newline.
  const isWindows = platform === "win32";
  const [gitDirOut, commonDirOut, toplevelOut] = await Promise.all([
    query(["rev-parse", "--absolute-git-dir"]),
    query(["rev-parse", "--git-common-dir"]),
    query(["rev-parse", "--show-toplevel"]),
  ]);
  if (watch) {
    // The core parses, lists and walks; the TypeScript helpers answer only without it.
    const listingOut = await query(["config", "-z", "--show-origin", "--show-scope", "--list"]);
    const files = await standard();
    if (!files) return undefined;
    return watch({
      cwd,
      gitDir: text(gitDirOut),
      commonDir: text(commonDirOut),
      toplevel: text(toplevelOut),
      listing: text(listingOut) === undefined ? undefined : listingOut.stdout,
      standard: files,
      home,
      isWindows,
    });
  }
  const gitDir = single(gitDirOut, isWindows);
  const commonDir = single(commonDirOut, isWindows);
  const toplevel = single(toplevelOut, isWindows);
  const layout =
    gitDir === undefined || commonDir === undefined || toplevel === undefined
      ? undefined
      : parseLayout(cwd, gitDir, commonDir, toplevel);
  if (!layout) return undefined;
  const listing = await query(["config", "-z", "--show-origin", "--show-scope", "--list"]);
  if (text(listing) === undefined) return undefined;
  const listed = listedSources(listing.stdout, layout, home);
  const files = await standard();
  if (!listed || !files) return undefined;
  return watchedPaths(cwd, layout, listed, files);
}
