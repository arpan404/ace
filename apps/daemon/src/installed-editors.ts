import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { InstalledEditor, type InstalledEditor as Editor } from "@ace/protocol";
import { editorCommandNames } from "@ace/ui-core/editor-commands";

const editors = [
  ["code", "Visual Studio Code"],
  ["cursor", "Cursor"],
  ["zed", "Zed"],
  ["subl", "Sublime Text"],
  ["idea", "IntelliJ IDEA"],
] as const;

/** macOS app bundles' launchers, under an Applications folder. */
const macBundles: Record<string, string> = {
  code: "Visual Studio Code.app/Contents/Resources/app/bin/code",
  cursor: "Cursor.app/Contents/Resources/app/bin/cursor",
  zed: "Zed.app/Contents/MacOS/cli",
  subl: "Sublime Text.app/Contents/SharedSupport/bin/subl",
  idea: "IntelliJ IDEA.app/Contents/MacOS/idea",
};

/**
 * Where editors install launchers outside PATH: Applications folders on macOS; snap, Flatpak
 * (system and per-user) and JetBrains Toolbox's script folder on Linux.
 */
export function editorLocations(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform === "darwin") return ["/Applications", join(home, "Applications")];
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

/**
 * Each editor's own executable on Windows, and where its installer puts it per user and per
 * machine. Windows discovery yields only these `.exe` files; it never reads or runs a `.cmd`
 * or `.bat` launcher, so a PATH entry holding one is ignored.
 */
const windowsExecutables: Readonly<Record<string, { exe: string; installs: readonly string[][] }>> =
  {
    code: {
      exe: "Code.exe",
      installs: [
        ["LOCALAPPDATA", "Programs", "Microsoft VS Code"],
        ["ProgramFiles", "Microsoft VS Code"],
      ],
    },
    cursor: { exe: "Cursor.exe", installs: [["LOCALAPPDATA", "Programs", "cursor"]] },
    zed: { exe: "Zed.exe", installs: [["LOCALAPPDATA", "Programs", "Zed"]] },
    subl: { exe: "sublime_text.exe", installs: [["ProgramFiles", "Sublime Text"]] },
    idea: { exe: "idea64.exe", installs: [] },
  };

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

/** Each editor's `.exe` on Windows: its App Paths registration, then its standard installs. */
async function windowsCandidates(id: string, windows: WindowsDiscovery): Promise<string[]> {
  const known = windowsExecutables[id];
  if (!known) return [];
  const registered = await windows.appPath?.(known.exe).catch(() => undefined);
  const installs = known.installs.flatMap(([variable = "", ...rest]) => {
    const base = windows.env[variable];
    return base && isAbsolute(base) ? [join(base, ...rest, known.exe)] : [];
  });
  // Only the editor's own executable counts, whatever a registration names.
  return [...(registered ? [registered] : []), ...installs].filter(
    (path) => isAbsolute(path) && basename(path).toLowerCase() === known.exe.toLowerCase(),
  );
}

/**
 * Editors with an executable launcher on this machine: the first found per editor, trying its
 * preferred launcher names on PATH, then `locations` (see `editorLocations`). On Windows only
 * each editor's own `.exe`, from App Paths or its standard install folders (`windows`).
 */
export async function installedEditors(
  paths: string | undefined,
  platform: NodeJS.Platform,
  locations: readonly string[] = [],
  windows: WindowsDiscovery = { env: {} },
): Promise<Editor[]> {
  const found: Editor[] = [];
  const directories = (paths ?? "").split(delimiter).filter(Boolean).slice(0, 128);
  for (const [id, name] of editors) {
    const candidates: string[] = [];
    if (platform === "win32") {
      candidates.push(...(await windowsCandidates(id, windows)));
    } else {
      const bundle = macBundles[id];
      const searched = platform === "darwin" ? directories : [...directories, ...locations];
      for (const command of editorCommandNames(id))
        for (const directory of searched) candidates.push(join(directory, command));
      if (platform === "darwin" && bundle)
        for (const directory of locations.slice(0, 8)) candidates.push(join(directory, bundle));
    }
    for (const command of candidates) {
      try {
        if (!(await stat(command)).isFile()) continue;
        await access(command, platform === "win32" ? constants.F_OK : constants.X_OK);
        found.push(InstalledEditor.parse({ id, name, command }));
        break;
      } catch {
        /* Not installed at this path. */
      }
    }
  }
  return found;
}
