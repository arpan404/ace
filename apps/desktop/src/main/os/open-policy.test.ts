import { describe, expect, it } from "vitest";
import { defaultOpenAction } from "./open-policy.ts";
import { finderFlagsMarkPackage } from "./package-folder.ts";

const file = { type: "file" } as const;
const folder = { type: "directory", package: false } as const;
const packageFolder = { type: "directory", package: true } as const;

describe("opening a path with the system's default handler", () => {
  it("opens plain folders, documents and source files", () => {
    expect(defaultOpenAction("/repo", folder, "darwin")).toBe("open");
    expect(defaultOpenAction("/repo/README.md", file, "darwin")).toBe("open");
    expect(defaultOpenAction("/repo/src/app.tsx", file, "win32")).toBe("open");
    expect(defaultOpenAction("/repo/Cargo.TOML", file, "linux")).toBe("open");
  });

  it("reveals folders macOS marks as packages, whatever their name", () => {
    expect(defaultOpenAction("/tmp/Innocent", packageFolder, "darwin")).toBe("reveal");
  });

  it("reveals any folder with an extension, since LaunchServices decides which are packages", () => {
    for (const path of [
      "/Applications/Evil.app",
      "/tmp/Install.pkg",
      "/tmp/Run.workflow",
      "/tmp/Step.action",
      "/tmp/Import.mdimporter",
      "/tmp/Audio.component",
      "/tmp/Script.scptd",
    ])
      expect(defaultOpenAction(path, folder, "darwin")).toBe("reveal");
  });

  it("reveals executables, installers and scripts the OS would run", () => {
    for (const path of [
      "/tmp/run.command",
      "/tmp/run.terminal",
      "/tmp/setup.dmg",
      "/tmp/tool.AppImage",
      "/tmp/app.desktop",
      "/tmp/install.sh",
      "/tmp/script.py",
      "C:\\tmp\\setup.exe",
      "C:\\tmp\\script.wsf",
      "C:\\tmp\\page.hta",
      "C:\\tmp\\keys.reg",
      "C:\\tmp\\panel.cpl",
      "C:\\tmp\\console.msc",
    ])
      expect(defaultOpenAction(path, file, "darwin")).toBe("reveal");
  });

  it("opens JavaScript only where no script host runs it by default", () => {
    expect(defaultOpenAction("/repo/index.js", file, "darwin")).toBe("open");
    expect(defaultOpenAction("C:\\repo\\index.js", file, "win32")).toBe("reveal");
  });

  it("reveals files without an extension, which macOS runs in Terminal when executable", () => {
    expect(defaultOpenAction("/repo/bin/tool", file, "darwin")).toBe("reveal");
  });
});

describe("the Finder bundle bit", () => {
  it("marks a folder as a package only when kHasBundle is set", () => {
    const info = new Uint8Array(32);
    expect(finderFlagsMarkPackage(info)).toBe(false);
    info[8] = 0x20; // kHasBundle (0x2000), big-endian
    expect(finderFlagsMarkPackage(info)).toBe(true);
    info[8] = 0x40; // kIsInvisible only
    expect(finderFlagsMarkPackage(info)).toBe(false);
  });
});
