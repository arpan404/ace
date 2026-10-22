import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { execArgument, nodeAutostartFiles, type AutostartFiles } from "./autostart.ts";

/** The app's desktop file id; Electron's `desktopName` and the Wayland app id match it. */
export const desktopFileId = "ace-desktop.desktop";

export interface AppImageEntryFiles extends AutostartFiles {
  exists(path: string): boolean;
  /** Copies a file, creating the target's folders. */
  copy(from: string, to: string): void;
}

export interface AppImageEntryOptions {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  files: AppImageEntryFiles;
  warn(message: string): void;
}

/**
 * The menu entry for an app run from an AppImage, which installs nothing by itself. Without an
 * `ace-desktop.desktop` entry the desktop doesn't know the app: on Wayland the portal refuses
 * its global shortcut ("An app id is required"), and launchers and `ace://` links can't find
 * it. So an AppImage launch writes the entry into `$XDG_DATA_HOME/applications`, pointing at
 * the AppImage file (never its temporary mount), with the image's icon copied beside it. An
 * entry a package already installed (the deb) is left to the package.
 */
export function installAppImageEntry(options: AppImageEntryOptions): void {
  const image = options.env.APPIMAGE;
  if (!image || !isAbsolute(image)) return;
  const shared = (options.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter((dir) => isAbsolute(dir));
  if (shared.some((dir) => options.files.exists(join(dir, "applications", desktopFileId)))) return;
  const data = dataHome(options.env, options.home);
  const path = join(data, "applications", desktopFileId);
  try {
    const mount = options.env.APPDIR;
    const icon = mount && isAbsolute(mount) ? join(mount, ".DirIcon") : undefined;
    let named = false;
    if (icon && options.files.exists(icon)) {
      options.files.copy(icon, join(data, "icons/hicolor/512x512/apps/ace-desktop.png"));
      named = true;
    }
    const entry = desktopEntry(image, named);
    if (options.files.read(path) !== entry) options.files.write(path, entry);
  } catch (error) {
    options.warn(`Could not add ace to the desktop's app list (${path}): ${String(error)}`);
  }
}

/** `$XDG_DATA_HOME` when it is an absolute path, as the XDG spec requires; else `~/.local/share`. */
function dataHome(env: AppImageEntryOptions["env"], home: string): string {
  const configured = env.XDG_DATA_HOME;
  return configured && isAbsolute(configured) ? configured : join(home, ".local", "share");
}

function desktopEntry(image: string, icon: boolean): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=ace",
    "Comment=Local multi-agent coding environment",
    `Exec=${execArgument(image)} %U`,
    ...(icon ? ["Icon=ace-desktop"] : []),
    "Terminal=false",
    "Categories=Development;",
    "MimeType=x-scheme-handler/ace;inode/directory;",
    "StartupWMClass=ace-desktop",
    "",
  ].join("\n");
}

/** `AppImageEntryFiles` on the real filesystem. */
export const nodeAppImageEntryFiles: AppImageEntryFiles = {
  ...nodeAutostartFiles,
  exists: (path) => existsSync(path),
  copy(from, to) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  },
};
