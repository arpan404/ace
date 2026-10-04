/*
 * The desktop app's folder access, through its preload bridge (`window.ace`): the native folder
 * picker and the paths of folders dropped on the window. In a browser there is no bridge and
 * `desktopFolders()` is undefined; the web picks folders with the daemon's folder browser.
 */

export interface DesktopFolders {
  /** The native folder picker: an absolute path, or null when the person cancels. */
  choose(): Promise<string | null>;
  /** The absolute path of a dropped file or folder, or null when it has none. */
  pathOf(file: File): string | null;
  /**
   * Whether the daemon runs on this computer, so a path picked here means the same folder
   * there. A desktop app attached to a remote daemon browses that machine's folders instead.
   */
  local(): Promise<boolean>;
}

const absolute = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));

function member(owner: unknown, key: string): unknown {
  return typeof owner === "object" && owner !== null ? Reflect.get(owner, key) : undefined;
}

export function desktopFolders(scope: object = globalThis): DesktopFolders | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const openFolder = member(member(ace, "dialogs"), "openFolder");
  const pathForFile = member(member(ace, "files"), "pathForFile");
  const status = member(member(ace, "daemon"), "status");
  if (typeof openFolder !== "function" || typeof pathForFile !== "function") return undefined;
  return {
    async choose() {
      const chosen: unknown = await openFolder();
      return absolute(chosen) ? chosen : null;
    },
    pathOf(file) {
      try {
        const path: unknown = pathForFile(file);
        return absolute(path) ? path : null;
      } catch {
        return null;
      }
    },
    async local() {
      if (typeof status !== "function") return true;
      try {
        return member(await status(), "source") !== "remote";
      } catch {
        return true;
      }
    },
  };
}
