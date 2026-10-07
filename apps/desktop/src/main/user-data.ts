import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The app's own data folder, a child of `app.getPath("appData")`. */
export const userDataName = "ace-next";

/**
 * Where the app keeps its own data (window state, settings, web storage, browser profiles and
 * the single-instance lock): `ACE_DESKTOP_USER_DATA` when set, else `<appData>/ace-next`
 * (macOS `~/Library/Application Support/ace-next`).
 *
 * It never depends on the daemon target. Electron's default for an app named "ace" is
 * `<appData>/ace`, which the older ace 0.x app owns, and the app can't tell reliably whether
 * that folder is the 0.x app's, so it never uses it: not for a refused or remote daemon, not
 * beside the daemon’s `~/.ace-next`. Pass the result through `checkUserData` before Electron uses it.
 */
export function desktopUserData(input: { explicit: string | undefined; appData: string }): string {
  return input.explicit ? resolve(input.explicit) : join(input.appData, userDataName);
}

/** The folders the older ace 0.x app owns, which the app's own data must never reach. */
export function legacyFolders(input: { appData: string; homedir: string }): string[] {
  return [join(input.appData, "ace"), join(input.homedir, ".ace")];
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** The real path `path` would have: its nearest existing ancestor resolved, the rest appended. */
function realTarget(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.toReversed());
    } catch (error) {
      if (!missing(error) || dirname(current) === current) throw error;
      rest.push(basename(current));
      current = dirname(current);
    }
  }
}

/** `child` is `parent` or inside it. */
const within = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/**
 * Checks the data folder before Electron initializes any storage in it. It is refused when
 * the folder itself is a symbolic link, or when it resolves (through any linked ancestor) into
 * a folder the 0.x app owns, so nothing this app persists can land in the legacy data.
 * Returns the reason it is refused, or undefined when it is safe.
 */
export function checkUserData(path: string, legacy: readonly string[]): string | undefined {
  try {
    if (lstatSync(path).isSymbolicLink())
      return `The app's data folder ${path} is a symbolic link; ace won't store data through it.`;
  } catch (error) {
    if (!missing(error)) return `Can't inspect the app's data folder ${path}: ${String(error)}`;
  }
  const target = realTarget(path);
  for (const folder of legacy) {
    const real = realTarget(folder);
    if (within(target, real) || within(target, resolve(folder)))
      return `The app's data folder ${path} resolves into ${folder}, which the older ace 0.x app owns; ace won't store data there. Set ACE_DESKTOP_USER_DATA to another folder.`;
  }
  return undefined;
}
