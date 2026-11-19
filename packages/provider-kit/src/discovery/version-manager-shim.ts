/**
 * Version managers whose shims resolve a tool when they run. Running one can install or update
 * the tool (mise's `lazy` and `auto_update`, proto's install-on-use), so ace never runs one to
 * read a version or a login status, or to list models: it asks the manager which installed
 * binary the shim stands for (see `findInstalledExecutable`) and runs that.
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

/** A shim ace won't run: its manager couldn't name the installed binary without risking an install. */
export class VersionManagerShimError extends Error {
  readonly path: string;
  readonly manager: VersionManager;
  readonly reason: string;
  constructor(path: string, manager: VersionManager, reason: string) {
    super(
      `${path} is a ${manager} shim and ${reason}. ace doesn't run a shim it can't resolve, because running it can install or update the tool. Set the provider's binary path to the installed executable.`,
    );
    this.name = "VersionManagerShimError";
    this.path = path;
    this.manager = manager;
    this.reason = reason;
  }
}

/** A probe of a shim whose manager reports the tool isn't installed: nothing was run. */
export class VersionManagerToolMissingError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} is a version manager's shim for a tool that isn't installed`);
    this.name = "VersionManagerToolMissingError";
    this.path = path;
  }
}
