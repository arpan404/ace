import { describe, expect, it } from "vitest";
import { appIcons, editorIcons, type AppImage, type IconLookup } from "./editor-icon.ts";

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

/** A disk holding exactly these apps; `all` holds any. */
const onDisk = (paths: string[]) => async (path: string) => paths.includes(path);
const all = async () => true;

describe("any installed app's icon by its path", () => {
  const ghostty = "/Applications/Ghostty.app";

  it("reads a bundle's icon, also for a launcher inside the bundle", async () => {
    const { lookup, asked } = machine({}, { [ghostty]: "data:image/png;base64,GH" });
    const icon = appIcons(lookup, "darwin", onDisk([ghostty]));
    await expect(icon(ghostty)).resolves.toBe("data:image/png;base64,GH");
    await expect(icon(`${ghostty}/Contents/MacOS/ghostty`)).resolves.toBe(
      "data:image/png;base64,GH",
    );
    expect(asked).toEqual([ghostty]);
  });

  it("has no icon for an app that isn't on this computer, such as another machine's", async () => {
    const { lookup, asked } = machine({}, { [ghostty]: "data:image/png;base64,GH" });
    await expect(appIcons(lookup, "darwin", onDisk([]))(ghostty)).resolves.toBeNull();
    expect(asked).toEqual([]);
  });

  it("only looks up app bundles and .exe files, never other paths", async () => {
    const { lookup, asked } = machine({}, { "/usr/bin/kitty": "data:image/png;base64,K" });
    await expect(appIcons(lookup, "darwin", all)("/usr/bin/kitty")).resolves.toBeNull();
    await expect(appIcons(lookup, "linux", all)("/opt/Foo.app")).resolves.toBeNull();
    await expect(appIcons(lookup, "win32", all)("C:\\tools\\wt.cmd")).resolves.toBeNull();
    expect(asked).toEqual([]);
  });

  it("reads a Windows app's icon from its own .exe", async () => {
    const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const { lookup } = machine({}, { [wt]: "data:image/png;base64,WT" });
    await expect(appIcons(lookup, "win32", onDisk([wt]))(wt)).resolves.toBe(
      "data:image/png;base64,WT",
    );
  });
});
