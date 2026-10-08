import { describe, expect, it } from "vitest";
import {
  appIcons,
  editorIcons,
  spotlightApp,
  type AppImage,
  type IconLookup,
} from "./editor-icon.ts";

const image = (url: string): AppImage => ({ isEmpty: () => false, toDataURL: () => url });
const empty: AppImage = { isEmpty: () => true, toDataURL: () => "data:image/png;base64," };

/** A machine with these apps registered for their URL schemes, and these bundles on disk. */
function machine(apps: Record<string, string>, files: Record<string, string> = {}) {
  const asked: string[] = [];
  const lookup: IconLookup = {
    async forProtocol(url) {
      asked.push(url);
      const icon = apps[url];
      if (!icon) throw new Error("No application registered");
      return image(icon);
    },
    async forFile(path) {
      asked.push(path);
      return files[path] ? image(files[path]) : empty;
    },
  };
  return { lookup, asked };
}

describe("editor icons", () => {
  it("reads an installed editor's icon from the app registered for its URL scheme", async () => {
    const { lookup } = machine({ "zed://": "data:image/png;base64,ZED" });
    const icon = editorIcons(lookup, "darwin");
    await expect(icon("zed")).resolves.toBe("data:image/png;base64,ZED");
  });

  it("has no icon for an editor that isn't installed", async () => {
    const { lookup } = machine({});
    await expect(editorIcons(lookup, "darwin")("cursor")).resolves.toBeNull();
  });

  it("reads Xcode's icon from its bundle on macOS, and has none elsewhere", async () => {
    const { lookup } = machine({}, { "/Applications/Xcode.app": "data:image/png;base64,XC" });
    await expect(editorIcons(lookup, "darwin")("xcode")).resolves.toBe("data:image/png;base64,XC");
    await expect(editorIcons(lookup, "linux")("xcode")).resolves.toBeNull();
  });

  it("an empty image from the OS counts as no icon", async () => {
    const { lookup } = machine({}, {});
    await expect(editorIcons(lookup, "darwin")("xcode")).resolves.toBeNull();
  });

  it("asks the OS once per editor however many times the page asks", async () => {
    const { lookup, asked } = machine({ "vscode://": "data:image/png;base64,VS" });
    const icon = editorIcons(lookup, "darwin");
    await Promise.all([icon("vscode"), icon("vscode"), icon("vscode")]);
    expect(asked).toEqual(["vscode://"]);
  });
});

/** Spotlight's answer for each bundle id, as mdfind prints it. */
function spotlight(found: Record<string, string>) {
  const queries: string[] = [];
  const findApp = spotlightApp(async (command, args) => {
    expect(command).toBe("/usr/bin/mdfind");
    queries.push(args.join(" "));
    const id = /"(.+)"/.exec(args[0] ?? "")?.[1] ?? "";
    return found[id] ?? "";
  });
  return { findApp, queries };
}
describe("app icons by bundle id", () => {
  const files = { "/Applications/Safari.app": "data:image/png;base64,SAFARI" };
  const forFile = async (path: string) =>
    files[path as keyof typeof files] ? image(files[path as keyof typeof files]) : empty;

  it("reads the icon of the app Spotlight finds for the bundle id", async () => {
    const { findApp } = spotlight({
      "com.apple.Safari": "/Users/dev/Library/Caches/x.plist\n/Applications/Safari.app\n",
    });
    const icon = appIcons({ findApp, forFile }, "darwin");
    await expect(icon("com.apple.Safari")).resolves.toBe("data:image/png;base64,SAFARI");
  });

  it("has no icon for an app that isn't installed, or off macOS", async () => {
    const { findApp } = spotlight({ "com.apple.Safari": "/Applications/Safari.app" });
    await expect(appIcons({ findApp, forFile }, "darwin")("com.example.gone")).resolves.toBeNull();
    await expect(appIcons({ findApp, forFile }, "linux")("com.apple.Safari")).resolves.toBeNull();
  });

  it("asks Spotlight once per app however many rows show it", async () => {
    const { findApp, queries } = spotlight({ "com.apple.Safari": "/Applications/Safari.app" });
    const icon = appIcons({ findApp, forFile }, "darwin");
    await Promise.all([icon("com.apple.Safari"), icon("com.apple.Safari")]);
    expect(queries).toEqual(['kMDItemCFBundleIdentifier == "com.apple.Safari"']);
  });
});
