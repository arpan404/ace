import { realpath } from "node:fs/promises";
import { findExecutable } from "./executable.ts";

/**
 * Version managers whose shims resolve a tool when they run. Running one can install or update
 * the tool (mise's `lazy` and `auto_update`, asdf's and proto's install-on-use), so ace never
 * runs one just to read a version or a login status.
 */
export type VersionManager = "mise" | "asdf" | "volta" | "proto";

/** The binary a shim links to, by name. mise was called rtx before 2024. */
const launchers: Readonly<Record<string, VersionManager>> = {
  mise: "mise",
  rtx: "mise",
  "volta-shim": "volta",
  "proto-shim": "proto",
};

/** Directories that hold only shims, wherever the manager's data directory is. */
const shimDirectories: readonly [RegExp, VersionManager][] = [
  [/\/(?:mise|rtx)\/(?:shims|command-wrappers(?:\/bin)?)\/[^/]+$/, "mise"],
  [/\/\.?asdf\/shims\/[^/]+$/, "asdf"],
  [/\/\.volta\/bin\/[^/]+$/, "volta"],
  [/\/\.proto\/shims\/[^/]+$/, "proto"],
];

/**
 * Which version manager a resolved executable belongs to, from its path and the file it
 * resolves to. Pure: the caller reads the filesystem.
 */
export function versionManagerShim(path: string, target: string): VersionManager | undefined {
  const name = (target.split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(/\.exe$/, "");
  const launcher = launchers[name];
  if (launcher) return launcher;
  const normalized = path.replaceAll("\\", "/");
  return shimDirectories.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** The manager behind `command` as `env`'s PATH resolves it, without running anything. */
export async function findVersionManagerShim(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; manager: VersionManager } | undefined> {
  const path = await findExecutable(command, env);
  if (!path) return undefined;
  const target = await realpath(path).catch(() => path);
  const manager = versionManagerShim(path, target);
  return manager ? { path, manager } : undefined;
}

/** A probe ace refused to run because its executable is a version manager's shim. */
export class VersionManagerShimError extends Error {
  readonly path: string;
  readonly manager: VersionManager;
  constructor(path: string, manager: VersionManager) {
    super(
      `${path} is a ${manager} shim. ace doesn't run it to check the CLI, because running it can install or update the tool. Set the provider's binary path to the installed executable.`,
    );
    this.name = "VersionManagerShimError";
    this.path = path;
    this.manager = manager;
  }
}
