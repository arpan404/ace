import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { InstalledEditor, type InstalledEditor as Editor } from "@ace/protocol";
import { openApps, type OpenApp } from "@ace/ui-core/open-apps";

/**
 * Where apps install outside PATH: Applications folders on macOS (the system's own, for
 * Terminal and Xcode); snap, Flatpak (system and per-user) and JetBrains Toolbox's script folder
 * on Linux.
 */
export function editorLocations(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform === "darwin")
    return [
      "/Applications",
      join(home, "Applications"),
      "/System/Applications",
      "/System/Applications/Utilities",
      "/Applications/Utilities",
    ];
  if (platform !== "linux") return [];
  const configured = env.XDG_DATA_HOME;
  const data = configured && isAbsolute(configured) ? configured : join(home, ".local", "share");
  return [
    "/snap/bin",
    "/var/lib/flatpak/exports/bin",
    join(data, "flatpak", "exports", "bin"),
    join(data, "JetBrains", "Toolbox", "scripts"),
  ];
}

/** Reads an App Paths registration's executable (`HKCU`, then `HKLM`), or undefined. */
export type AppPathReader = (exe: string) => Promise<string | undefined>;

/** What Windows discovery reads: the environment's install roots and the App Paths registry. */
export interface WindowsDiscovery {
  env: Readonly<Record<string, string | undefined>>;
  appPath?: AppPathReader;
}

/** The registry through `reg.exe` from the system folder, run without a shell. */
export function registryAppPath(env: WindowsDiscovery["env"]): AppPathReader {
  const reg = join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "reg.exe");
  const query = (key: string) =>
    new Promise<string | undefined>((resolve) => {
      execFile(
        reg,
        ["query", key, "/ve"],
        { shell: false, windowsHide: true, timeout: 5_000 },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
  return async (exe) => {
    for (const hive of ["HKCU", "HKLM"]) {
      const out = await query(
        `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      );
      const value = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out ?? "")?.[1];
      if (!value) continue;
      return value
        .replace(/^"(.*)"$/, "$1")
        .replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole);
    }
    return undefined;
  };
}

/** How discovery asks the filesystem; the real one by default, a fake in tests. */
export interface AppProbe {
  /** A regular file this user may run (on Windows: a regular file). */
  runnable(path: string, platform: NodeJS.Platform): Promise<boolean>;
  /** A folder: a macOS app bundle. */
  folder(path: string): Promise<boolean>;
}

export const fileProbe: AppProbe = {
  async runnable(path, platform) {
    try {
      if (!(await stat(path)).isFile()) return false;
      await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async folder(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** One place a launcher may be: a file to run, or (macOS) a bundle to open. */
type Candidate = { path: string; bundle: boolean };

/** Each app's `.exe` on Windows: its App Paths registration, then its standard installs. */
async function windowsCandidates(app: OpenApp, windows: WindowsDiscovery): Promise<Candidate[]> {
  const known = app.windows;
  if (!known) return [];
  const registered = await windows.appPath?.(known.exe).catch(() => undefined);
  const installs = known.installs.flatMap(([variable = "", ...rest]) => {
    const base = windows.env[variable];
    return base && isAbsolute(base) ? [join(base, ...rest, known.exe)] : [];
  });
  // Only the app's own executable counts, whatever a registration names.
  return [...(registered ? [registered] : []), ...installs]
    .filter((path) => isAbsolute(path) && basename(path).toLowerCase() === known.exe.toLowerCase())
    .map((path) => ({ path, bundle: false }));
}

/** Where `app` may be on macOS or Linux, preferred first. */
function unixCandidates(
  app: OpenApp,
  platform: NodeJS.Platform,
  directories: readonly string[],
  locations: readonly string[],
): Candidate[] {
  const onPath = (searched: readonly string[]) =>
    app.commands.flatMap((command) =>
      searched.map((directory) => ({ path: join(directory, command), bundle: false })),
    );
  if (platform !== "darwin")
    return app.linux === false ? [] : onPath([...directories, ...locations]);
  const mac = app.mac;
  if (!mac) return [];
  const bundles = locations
    .slice(0, 8)
    .flatMap((directory) => mac.apps.map((name) => join(directory, name)));
  return [
    ...(mac.searchPath ? onPath(directories) : []),
    ...(mac.cli
      ? bundles.map((bundle) => ({ path: join(bundle, mac.cli ?? ""), bundle: false }))
      : []),
    ...bundles.map((path) => ({ path, bundle: true })),
  ];
}

export interface InstalledApps {
  editors: Editor[];
  terminals: Editor[];
}

/**
 * The catalogued apps installed on this machine, editors and terminals apart: the first launcher
 * found per app, trying its preferred names on PATH, then `locations` (see `editorLocations`).
 * On macOS an app without its own launcher counts by its bundle, which then opens with
 * `open -a`. On Windows only each app's own `.exe`, from App Paths or its install folders.
 */
export async function installedApps(input: {
  paths: string | undefined;
  platform: NodeJS.Platform;
  locations?: readonly string[];
  windows?: WindowsDiscovery;
  probe?: AppProbe;
}): Promise<InstalledApps> {
  const { platform, locations = [], windows = { env: {} }, probe = fileProbe } = input;
  const directories = (input.paths ?? "").split(delimiter).filter(Boolean).slice(0, 128);
  const found: InstalledApps = { editors: [], terminals: [] };
  for (const app of openApps) {
    const candidates =
      platform === "win32"
        ? await windowsCandidates(app, windows)
        : unixCandidates(app, platform, directories, locations);
    for (const candidate of candidates) {
      const present = candidate.bundle
        ? await probe.folder(candidate.path)
        : await probe.runnable(candidate.path, platform);
      if (!present) continue;
      const entry = InstalledEditor.parse({ id: app.id, name: app.name, command: candidate.path });
      (app.kind === "terminal" ? found.terminals : found.editors).push(entry);
      break;
    }
  }
  return found;
}

/** The installed editors alone (see `installedApps`). */
export async function installedEditors(
  paths: string | undefined,
  platform: NodeJS.Platform,
  locations: readonly string[] = [],
  windows: WindowsDiscovery = { env: {} },
): Promise<Editor[]> {
  return (await installedApps({ paths, platform, locations, windows })).editors;
}
