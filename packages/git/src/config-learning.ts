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

/** One path value from Git: only the final newline is stripped, embedded newlines stay. */
function single(output: QueryOutput): string | undefined {
  const full = text(output);
  if (full === undefined) return undefined;
  return full.endsWith("\n") ? full.slice(0, -1) : full;
}

/**
 * The system file and both global files (XDG, then `~/.gitconfig`) as this Git build names them,
 * present or not. Undefined on a Git too old to say (`git var` learned them in 2.42).
 */
export async function standardConfigFiles(query: Query): Promise<string[] | undefined> {
  // `GIT_CONFIG_SYSTEM` names one file; `GIT_CONFIG_GLOBAL` names two (XDG, then `~/.gitconfig`).
  // Each is one value per line only for ordinary paths: strip just the final newline per value.
  const system = single(await query(["var", "GIT_CONFIG_SYSTEM"]));
  const global = text(await query(["var", "GIT_CONFIG_GLOBAL"]));
  if (system === undefined || global === undefined) return undefined;
  const globalText = global.endsWith("\n") ? global.slice(0, -1) : global;
  const files = [system, ...globalText.split("\n")].filter(Boolean);
  return files.length >= 2 && files.every((file) => isAbsolute(file)) ? files : undefined;
}

/**
 * Every file whose change could alter the configuration a Git command in `cwd` reads, asked of
 * Git itself (`rev-parse` for discovery, `config --list --show-origin` for files and includes).
 * Undefined whenever any of it can't be named exactly: then nothing is cached for `cwd`.
 */
export async function learnConfigSources(
  cwd: string,
  query: Query,
  standard: () => Promise<string[] | undefined>,
  home: string | undefined,
): Promise<string[] | undefined> {
  // A path through a symbolic link can be pointed at another checkout without any file changing.
  if ((await realpath(cwd).catch(() => undefined)) !== cwd) return undefined;
  // One path per invocation (`rev-parse` offers no NUL mode for paths): each keeps embedded
  // newlines, stripped of only its final newline.
  const [gitDirOut, commonDirOut, toplevelOut] = await Promise.all([
    query(["rev-parse", "--absolute-git-dir"]),
    query(["rev-parse", "--git-common-dir"]),
    query(["rev-parse", "--show-toplevel"]),
  ]);
  const gitDir = single(gitDirOut);
  const commonDir = single(commonDirOut);
  const toplevel = single(toplevelOut);
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
