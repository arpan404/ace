import { describe, expect, it } from "vitest";
import { defaultOpenAction } from "./open-policy.ts";

describe("opening a path with the system's default handler", () => {
  it("opens folders, documents and source files", () => {
    expect(defaultOpenAction("/repo", true, "darwin")).toBe("open");
    expect(defaultOpenAction("/repo/README.md", false, "darwin")).toBe("open");
    expect(defaultOpenAction("/repo/src/app.tsx", false, "win32")).toBe("open");
    expect(defaultOpenAction("/repo/Cargo.TOML", false, "linux")).toBe("open");
  });

  it("reveals app bundles and other launchable folders instead of launching them", () => {
    expect(defaultOpenAction("/Applications/Evil.app", true, "darwin")).toBe("reveal");
    expect(defaultOpenAction("/tmp/Install.pkg", true, "darwin")).toBe("reveal");
    expect(defaultOpenAction("/tmp/Run.workflow", true, "darwin")).toBe("reveal");
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
      expect(defaultOpenAction(path, false, "darwin")).toBe("reveal");
  });

  it("opens JavaScript only where no script host runs it by default", () => {
    expect(defaultOpenAction("/repo/index.js", false, "darwin")).toBe("open");
    expect(defaultOpenAction("C:\\repo\\index.js", false, "win32")).toBe("reveal");
  });

  it("reveals files without an extension, which macOS runs in Terminal when executable", () => {
    expect(defaultOpenAction("/repo/bin/tool", false, "darwin")).toBe("reveal");
  });
});
