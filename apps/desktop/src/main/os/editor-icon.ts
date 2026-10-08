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
