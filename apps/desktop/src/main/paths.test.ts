import { describe, expect, test } from "vitest";
import { appPaths } from "./paths.ts";

/** The tray image a Windows build (installed or not) asks for. */
function windowsTray(packaged: boolean): string {
  return appPaths({
    appDirectory: "C:\\ace\\dist\\app",
    packaged,
    resourcesPath: "C:\\Program Files\\ace\\resources",
    platform: "win32",
  }).trayIcon;
}

describe.runIf(process.platform === "win32")("the Windows tray image", () => {
  test("is the colour tile, which the never-tinting taskbar shows on light and dark", () => {
    expect(windowsTray(true)).toMatch(/[\\/]icons[\\/]trayColor\.png$/);
    expect(windowsTray(false)).toMatch(/[\\/]resources[\\/]trayColor\.png$/);
  });
});
