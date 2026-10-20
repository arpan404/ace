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

/**
 * The system file and both global files (XDG, then `~/.gitconfig`) as this Git build names them,
 * present or not. Undefined on a Git too old to say (`git var` learned them in 2.42).
 */
export async function standardConfigFiles(query: Query): Promise<string[] | undefined> {
  const system = text(await query(["var", "GIT_CONFIG_SYSTEM"]));
  const global = text(await query(["var", "GIT_CONFIG_GLOBAL"]));
  if (system === undefined || global === undefined) return undefined;
  const files = [...system.split("\n"), ...global.split("\n")].filter(Boolean);
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
  const layoutText = text(
    await query(["rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"]),
  );
  const layout = layoutText === undefined ? undefined : parseLayout(cwd, layoutText);
  if (!layout) return undefined;
  const listing = await query(["config", "-z", "--show-origin", "--show-scope", "--list"]);
  if (text(listing) === undefined) return undefined;
  const listed = listedSources(listing.stdout, layout, home);
  const files = await standard();
  if (!listed || !files) return undefined;
  return watchedPaths(cwd, layout, listed, files);
}
