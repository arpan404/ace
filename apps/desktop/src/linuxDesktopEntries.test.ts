import { describe, expect, it } from "vitest";

import {
  buildLinuxDaemonAutostartEntry,
  buildLinuxDesktopApplicationEntry,
} from "./linuxDesktopEntries";

describe("buildLinuxDaemonAutostartEntry", () => {
  it("builds a hidden autostart entry", () => {
    expect(
      buildLinuxDaemonAutostartEntry({
        appName: "ace",
        executablePath: "/opt/ace/ace.AppImage",
        args: ["--daemon-login-item"],
      }),
    ).toContain("NoDisplay=true");
  });
});

describe("buildLinuxDesktopApplicationEntry", () => {
  it("builds a launcher entry for the desktop app", () => {
    const entry = buildLinuxDesktopApplicationEntry({
      appName: "ace",
      executablePath: "/home/test/Applications/ace.AppImage",
      iconPath: "/home/test/.local/share/icons/hicolor/512x512/apps/ace.png",
      desktopFileId: "ace.desktop",
      startupWmClass: "ace",
    });

    expect(entry).toContain("Name=ace");
    expect(entry).toContain('Exec="/home/test/Applications/ace.AppImage"');
    expect(entry).toContain("Icon=/home/test/.local/share/icons/hicolor/512x512/apps/ace.png");
    expect(entry).toContain("DesktopFileName=ace.desktop");
    expect(entry).toContain("StartupWMClass=ace");
    expect(entry).toContain("Categories=Development;");
  });
});
