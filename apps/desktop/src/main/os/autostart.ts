import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { backgroundArgument } from "./login.ts";

/** The file operations an XDG autostart entry needs: the real `node:fs` in the app, a temp dir in tests. */
export interface AutostartFiles {
  /** The file's text, or undefined when it doesn't exist. */
  read(path: string): string | undefined;
  /** Creates parent folders as needed. */
  write(path: string, text: string): void;
  /** No error when the file is already gone. */
  remove(path: string): void;
}

export interface AutostartOptions {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** The running executable (`process.execPath`). */
  execPath: string;
  /** Reverse-DNS app id; the entry is `<appId>.desktop`. */
  appId: string;
  files: AutostartFiles;
  warn(message: string): void;
}

/**
 * Launch at login on Linux, where Electron has no login items: an XDG autostart entry in
 * `$XDG_CONFIG_HOME/autostart` (`~/.config/autostart` by default) that starts the app with
 * `--background`. Under an AppImage the entry points at the AppImage file (`$APPIMAGE`), never
 * at the executable inside its temporary mount, which is gone after the app quits.
 *
 * `enabled()` is true only while the entry is exactly the one this launch would write, so an
 * entry left by a moved or replaced AppImage is rewritten with the current path.
 */
export function linuxAutostart(options: AutostartOptions): {
  enabled(): boolean;
  setEnabled(on: boolean): void;
} {
  const path = join(configHome(options.env, options.home), "autostart", `${options.appId}.desktop`);
  const executable = options.env.APPIMAGE || options.execPath;
  let entry: string | undefined;
  try {
    entry = desktopEntry(executable);
  } catch (error) {
    options.warn(`Launch at login is unavailable: ${String(error)}`);
  }
  return {
    enabled() {
      try {
        return entry !== undefined && options.files.read(path) === entry;
      } catch {
        return false;
      }
    },
    setEnabled(on) {
      try {
        if (!on) options.files.remove(path);
        else if (entry !== undefined) options.files.write(path, entry);
      } catch (error) {
        options.warn(
          `Could not ${on ? "add" : "remove"} the login entry ${path}: ${String(error)}`,
        );
      }
    },
  };
}

/** `$XDG_CONFIG_HOME` when it is an absolute path, as the XDG spec requires; else `~/.config`. */
function configHome(env: AutostartOptions["env"], home: string): string {
  const configured = env.XDG_CONFIG_HOME;
  return configured && isAbsolute(configured) ? configured : join(home, ".config");
}

function desktopEntry(executable: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=ace",
    "Comment=Start ace in the background at login",
    `Exec=${execArgument(executable)} ${backgroundArgument}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/**
 * One `Exec` argument, quoted by the Desktop Entry rules: inside double quotes `"`, `` ` ``,
 * `$` and `\` take a backslash; the string-value escape then doubles every backslash, and a
 * literal `%` is written `%%` so it isn't read as a field code.
 */
export function execArgument(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error("The executable path contains a line break");
  const quoted = `"${value.replace(/["`$\\]/g, "\\$&")}"`;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

/** `AutostartFiles` on the real filesystem. */
export const nodeAutostartFiles: AutostartFiles = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  },
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o644 });
  },
  remove(path) {
    rmSync(path, { force: true });
  },
};
