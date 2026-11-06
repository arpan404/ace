import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The folder, under the temporary root, that holds the e2e daemon's fixtures and nothing else. */
export const fixtureRootName = "ace-web-e2e";

export interface E2eLayout {
  tmpRoot: string;
  /** The fixture root: `<tmpRoot>/ace-web-e2e`. */
  root: string;
  name: string;
  /** `<root>/<name>`. */
  daemonHome: string;
  /** `<root>/<name>-projects`: the project journeys' only allowed root. */
  projectsRoot: string;
}

/**
 * The temporary root: the system's on Windows; /tmp elsewhere, which keeps the projects root
 * out of macOS's per-user temporary directory (its real path is under /private/var, a folder
 * the daemon never opens as a project).
 */
export function defaultTmpRoot(platform: NodeJS.Platform, systemTmp: string): string {
  return platform === "win32" ? systemTmp : "/tmp";
}

/**
 * Where the e2e daemon lives, from the temporary root and the fixture name alone. The name is
 * one plain folder name, so neither path can leave the fixture root.
 */
export function e2eLayout(tmpRoot: string, name: string): E2eLayout {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.endsWith("-projects"))
    throw new Error(
      `The e2e fixture name (ACE_E2E_DAEMON_HOME) must be a plain folder name, not ${JSON.stringify(name)}`,
    );
  const root = join(tmpRoot, fixtureRootName);
  return {
    tmpRoot,
    root,
    name,
    daemonHome: join(root, name),
    projectsRoot: join(root, `${name}-projects`),
  };
}

/** Creates the fixture root, private to this user, and checks it is a folder of their own. */
export function prepareFixtureRoot(layout: E2eLayout): void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  assertFixtureRoot(layout);
}

function assertFixtureRoot(layout: E2eLayout): void {
  const root = lstatSync(layout.root);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error(`The e2e fixture root ${layout.root} must be a folder, not a link`);
  const uid = process.getuid?.();
  if (uid !== undefined && root.uid !== uid)
    throw new Error(`The e2e fixture root ${layout.root} belongs to another user`);
}

/**
 * Refuses to remove anything but the layout's daemon home or projects root, directly inside a
 * fixture root of this user's own. A target that is a link is refused too.
 * Call it right before every recursive removal.
 */
export function assertRemovable(target: string, layout: E2eLayout): void {
  if (target !== layout.daemonHome && target !== layout.projectsRoot)
    throw new Error(`Refusing to remove ${target}: it is not an e2e fixture folder`);
  // Both targets sit directly in the root, so a root that is no link of anyone's keeps them in it.
  assertFixtureRoot(layout);
  let existing;
  try {
    existing = lstatSync(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (existing.isSymbolicLink()) throw new Error(`Refusing to remove ${target}: it is a link`);
}
