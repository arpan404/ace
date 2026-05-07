import { describe, expect, it } from "vitest";

import { buildLinuxDaemonAutostartEntry, quoteDesktopEntryExecArgument } from "./linuxAutostart";

describe("linuxAutostart", () => {
  it("quotes Exec arguments for desktop entry parsing", () => {
    expect(quoteDesktopEntryExecArgument('/opt/Ace "$HOME"/ace`bin`')).toBe(
      '"/opt/Ace \\"\\$HOME\\"/ace\\`bin\\`"',
    );
  });

  it("strips line breaks from values that are written into a desktop entry", () => {
    const entry = buildLinuxDaemonAutostartEntry({
      appName: "ace\nInjected=true",
      executablePath: "/opt/ace\nbad",
      args: ["--daemon-login-item", "value\r\nOther=true"],
    });

    expect(entry).toContain("Name=ace Injected=true daemon");
    expect(entry).toContain('Exec="/opt/ace bad" "--daemon-login-item" "value  Other=true"');
    expect(entry).not.toContain("\nInjected=true");
    expect(entry).not.toContain("\nOther=true");
  });

  it("builds an XDG autostart entry for daemon login startup", () => {
    expect(
      buildLinuxDaemonAutostartEntry({
        appName: "ace",
        executablePath: "/opt/ace/ace",
        args: ["--daemon-login-item"],
      }),
    ).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Version=1.0",
        "Name=ace daemon",
        "Comment=Start the ace background daemon at login",
        'Exec="/opt/ace/ace" "--daemon-login-item"',
        "Terminal=false",
        "NoDisplay=true",
        "StartupNotify=false",
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n"),
    );
  });
});
