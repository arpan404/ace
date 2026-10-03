import { describe, expect, it } from "vitest";
import { startHidden } from "./login.ts";

const launch = {
  platform: "darwin" as NodeJS.Platform,
  argv: ["/Applications/ace.app/Contents/MacOS/ace"],
  wasOpenedAtLogin: false,
  background: true,
};

describe("starting at login", () => {
  it("starts hidden on macOS when opened at login, where login-item arguments are ignored", () => {
    expect(startHidden({ ...launch, wasOpenedAtLogin: true })).toBe(true);
  });

  it("opens the window when the person launches the app themselves", () => {
    expect(startHidden(launch)).toBe(false);
  });

  it("starts hidden on Windows from the login item's argument", () => {
    expect(startHidden({ ...launch, platform: "win32", argv: ["ace.exe", "--background"] })).toBe(
      true,
    );
  });

  it("ignores macOS's login flag on other platforms", () => {
    expect(startHidden({ ...launch, platform: "linux", wasOpenedAtLogin: true })).toBe(false);
  });

  it("always opens a window when background mode is off, since there is no tray to open it", () => {
    expect(
      startHidden({
        ...launch,
        wasOpenedAtLogin: true,
        argv: ["ace", "--background"],
        background: false,
      }),
    ).toBe(false);
  });
});
