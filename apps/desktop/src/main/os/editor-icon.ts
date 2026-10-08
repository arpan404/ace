import type { EditorId } from "../../shared/contract.ts";

/*
 * An installed editor's own icon, read from the OS, so "Open in" shows the app as the system
 * does without ace bundling anyone's logo. The app is found by the URL scheme it registered (the
 * same handler `openInEditor` opens), or by its bundle where it has none.
 */

/** What the OS hands back for an app: Electron's NativeImage, as far as this uses it. */
export interface AppImage {
  isEmpty(): boolean;
  toDataURL(): string;
}

/** The two Electron `app` lookups this needs, injected so the choice is testable. */
export interface IconLookup {
  /** macOS and Windows: the app registered for a URL's scheme. Throws where there is none. */
  forProtocol(url: string): Promise<AppImage>;
  /** The file manager's icon for a path (an `.app` bundle on macOS). */
  forFile(path: string): Promise<AppImage>;
}

const schemes: Partial<Record<EditorId, string>> = {
  vscode: "vscode://",
  cursor: "cursor://",
  zed: "zed://",
  idea: "idea://",
};

/** Apps without a URL scheme of their own, by platform. */
const bundles: Partial<Record<NodeJS.Platform, Partial<Record<EditorId, string>>>> = {
  darwin: { xcode: "/Applications/Xcode.app" },
};

/**
 * The editor's icon as a PNG data URL, or null when the OS has none for it (not installed, or a
 * platform without the lookup). Each editor is looked up once per run.
 */
export function editorIcons(lookup: IconLookup, platform: NodeJS.Platform) {
  const cache = new Map<EditorId, Promise<string | null>>();
  const read = async (editor: EditorId): Promise<string | null> => {
    const scheme = schemes[editor];
    const bundle = bundles[platform]?.[editor];
    try {
      const image = scheme
        ? await lookup.forProtocol(scheme)
        : bundle
          ? await lookup.forFile(bundle)
          : undefined;
      return image && !image.isEmpty() ? image.toDataURL() : null;
    } catch {
      // Not installed, or the platform can't say (Linux has no protocol lookup).
      return null;
    }
  };
  return (editor: EditorId): Promise<string | null> => {
    let icon = cache.get(editor);
    if (!icon) cache.set(editor, (icon = read(editor)));
    return icon;
  };
}

/** Finding an app by its bundle id, on top of reading a file's icon. */
export interface AppLookup extends Pick<IconLookup, "forFile"> {
  /** The app bundle's path for a bundle id (Spotlight on macOS), or undefined. */
  findApp(bundleId: string): Promise<string | undefined>;
}

/**
 * Any app's icon by its bundle id, as a PNG data URL, so computer-use steps show the app the
 * agent used as the system draws it. Null when the app isn't found or the platform has no
 * bundle ids. Each id is looked up once per run.
 */
export function appIcons(lookup: AppLookup, platform: NodeJS.Platform) {
  const cache = new Map<string, Promise<string | null>>();
  const read = async (bundleId: string): Promise<string | null> => {
    if (platform !== "darwin") return null;
    try {
      const path = await lookup.findApp(bundleId);
      if (!path) return null;
      const image = await lookup.forFile(path);
      return image.isEmpty() ? null : image.toDataURL();
    } catch {
      return null;
    }
  };
  return (bundleId: string): Promise<string | null> => {
    let icon = cache.get(bundleId);
    if (!icon) cache.set(bundleId, (icon = read(bundleId)));
    return icon;
  };
}

/** The first `.app` Spotlight lists for a bundle id; never launches the app. */
export function spotlightApp(
  run: (command: string, args: string[]) => Promise<string>,
): AppLookup["findApp"] {
  return async (bundleId) => {
    const out = await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${bundleId}"`]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(".app"));
  };
}
