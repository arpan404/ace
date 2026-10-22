import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renderLauncher } from "@ace/service/home";
import {
  cliShimLocation,
  planCliShim,
  renderCliShim,
  transientAppPath,
  type CliShimResult,
  type ExistingShim,
} from "./cli-shim.ts";

/** Larger than any shim ace has written; such a file is never read whole or replaced. */
const maxShimBytes = 4096;

export interface CliShimInstall {
  /** The daemon home, already prepared (`~/.ace` by default); the shim goes in its `bin`. */
  dataHome: string;
  platform: NodeJS.Platform;
  /** The bundled Node runtime and daemon CLI, as `appPaths` resolves them. */
  node: string;
  entry: string;
}

/**
 * Writes or refreshes the `ace` command so it runs this app's bundled daemon CLI from the
 * app's real location. Never throws: every outcome, including a failure, is the result.
 */
export async function installCliShim(options: CliShimInstall): Promise<CliShimResult> {
  const { directory, file } = cliShimLocation(options.dataHome, options.platform);
  let content: string;
  try {
    const target = { node: await realFile(options.node), entry: await realFile(options.entry) };
    if (transientAppPath(target.node, options.platform))
      return {
        state: "skipped",
        reason: "ace is running from a temporary location; move it to Applications",
      };
    content = renderCliShim(target, options.platform);
  } catch (error) {
    if (code(error) === "ENOENT")
      return { state: "skipped", reason: "this build has no bundled runtime" };
    return { state: "failed", file, message: message(error) };
  }
  try {
    const plan = planCliShim(
      await existing(file, options.platform),
      content,
      options.platform === "win32" ? undefined : renderLauncher(options.dataHome),
    );
    if (plan === "foreign") return { state: "foreign", file };
    if (plan !== "unchanged") await writeShim(directory, file, content);
    const state = plan === "create" ? "created" : plan === "replace" ? "replaced" : "unchanged";
    return { state, file, directory };
  } catch (error) {
    return { state: "failed", file, message: message(error) };
  }
}

/** The file's path with every folder above it resolved, so a moved or linked app still works. */
async function realFile(path: string): Promise<string> {
  const real = join(await realpath(dirname(path)), basename(path));
  await lstat(real);
  return real;
}

async function existing(file: string, platform: NodeJS.Platform): Promise<ExistingShim> {
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (code(error) === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (!stats.isFile() || stats.size > maxShimBytes) return { kind: "other" };
  return {
    kind: "file",
    content: await readFile(file, "utf8"),
    executable: platform === "win32" || (stats.mode & 0o111) !== 0,
  };
}

/** Write beside the shim, then rename over it, so a terminal never runs half a file. */
async function writeShim(directory: string, file: string, content: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
