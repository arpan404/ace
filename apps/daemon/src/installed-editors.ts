import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
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
 * Editors with an executable launcher on this machine: the first found per editor, trying its
 * preferred launcher names on PATH, then `locations` (see `editorLocations`).
 */
export async function installedEditors(
  paths: string | undefined,
  platform: NodeJS.Platform,
  locations: readonly string[] = [],
): Promise<Editor[]> {
  const found: Editor[] = [];
  const directories = (paths ?? "").split(delimiter).filter(Boolean).slice(0, 128);
  for (const [id, name] of editors) {
    const candidates: string[] = [];
    if (platform === "win32") {
      for (const directory of directories) candidates.push(join(directory, `${id}.cmd`));
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
