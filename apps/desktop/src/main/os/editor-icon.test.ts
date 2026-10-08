import { describe, expect, it } from "vitest";
import { editorIcons, type AppImage, type IconLookup } from "./editor-icon.ts";

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
