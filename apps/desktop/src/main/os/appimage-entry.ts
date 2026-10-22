import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { execArgument, nodeAutostartFiles, type AutostartFiles } from "./autostart.ts";
import { linuxInstall } from "./linux-sandbox.ts";

/**
 * The app's desktop file id. Electron's `desktopName` (scripts/build.ts), the window class and
 * Wayland app id, the deb's entry and the GlobalShortcuts portal's app id all match it: portals
 * need a reverse-DNS id, and GNOME refuses shortcuts to one like `ace-desktop`.
 */
export const desktopFileId = "dev.ace.app.desktop";
/** The entry an earlier AppImage launch wrote, before the app id was `dev.ace.app`. */
const staleDesktopFileId = "ace-desktop.desktop";

export interface AppImageEntryFiles extends AutostartFiles {
  exists(path: string): boolean;
  /** Copies a file, creating the target's folders. */
  copy(from: string, to: string): void;
}

export interface AppImageEntryOptions {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** The running executable (`process.execPath`). */
  execPath: string;
  files: AppImageEntryFiles;
  warn(message: string): void;
}

/**
 * The menu entry for an app run from an AppImage or an extracted tar.gz, which install nothing
 * by themselves. Without a `dev.ace.app.desktop` entry the desktop doesn't know the app: on
 * Wayland the portal refuses its global shortcut ("An app id is required"), and launchers and
 * `ace://` links can't find it. So such a launch writes the entry into
 * `$XDG_DATA_HOME/applications`, pointing at the AppImage file (never its temporary mount) or
 * the tar.gz's launcher, with the app's icon copied beside it. An entry a package already
 * installed (the deb) is left to the package, and the deb's own launch removes an entry an
 * AppImage wrote earlier, which would shadow the package's. An `ace-desktop.desktop` an
 * earlier AppImage launch wrote is removed too, so the app list doesn't show ace twice.
 */
export function installAppImageEntry(options: AppImageEntryOptions): void {
  const install = linuxInstall(options.env, options.execPath);
  const source =
    install.kind === "appimage"
      ? { exec: install.image, icon: mountIcon(options.env) }
      : install.kind === "tarball"
        ? {
            exec: join(install.directory, "ace-desktop"),
            icon: join(install.directory, "ace-desktop.png"),
          }
        : undefined;
  const data = dataHome(options.env, options.home);
  const path = join(data, "applications", desktopFileId);
  try {
    if (install.kind === "deb" || source) {
      removeOwnEntry(options.files, join(data, "applications", staleDesktopFileId), "ace-desktop");
    }
    if (install.kind === "deb") removeOwnEntry(options.files, path, "dev.ace.app");
    if (!source) return;
    const shared = (options.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
      .split(":")
      .filter((dir) => isAbsolute(dir));
    if (shared.some((dir) => options.files.exists(join(dir, "applications", desktopFileId))))
      return;
    let named = false;
    if (source.icon && options.files.exists(source.icon)) {
      options.files.copy(source.icon, join(data, "icons/hicolor/512x512/apps/ace-desktop.png"));
      named = true;
    }
    const entry = desktopEntry(source.exec, named);
    if (options.files.read(path) !== entry) options.files.write(path, entry);
  } catch (error) {
    options.warn(`Could not add ace to the desktop's app list (${path}): ${String(error)}`);
  }
}

/** The AppImage's own icon, on its mount. */
function mountIcon(env: AppImageEntryOptions["env"]): string | undefined {
  const mount = env.APPDIR;
  return mount && isAbsolute(mount) ? join(mount, ".DirIcon") : undefined;
}

/** Removes an entry only when an earlier launch of ace wrote it, never one the person made. */
function removeOwnEntry(files: AppImageEntryFiles, path: string, windowClass: string): void {
  const text = files.read(path);
  if (
    text?.includes("\nComment=Local multi-agent coding environment\n") &&
    text.includes(`\nStartupWMClass=${windowClass}\n`)
  )
    files.remove(path);
}

/** `$XDG_DATA_HOME` when it is an absolute path, as the XDG spec requires; else `~/.local/share`. */
function dataHome(env: AppImageEntryOptions["env"], home: string): string {
  const configured = env.XDG_DATA_HOME;
  return configured && isAbsolute(configured) ? configured : join(home, ".local", "share");
}

function desktopEntry(executable: string, icon: boolean): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=ace",
    "Comment=Local multi-agent coding environment",
    `Exec=${execArgument(executable)} %U`,
    ...(icon ? ["Icon=ace-desktop"] : []),
    "Terminal=false",
    "Categories=Development;",
    "MimeType=x-scheme-handler/ace;inode/directory;",
    "StartupWMClass=dev.ace.app",
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
