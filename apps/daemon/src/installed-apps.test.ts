import { expect, test } from "vitest";
import { installedApps, type AppProbe } from "./installed-editors.ts";

/** A filesystem holding exactly these runnable files and folders. */
function probe(files: readonly string[], folders: readonly string[] = []): AppProbe {
  return {
    runnable: async (path) => files.includes(path),
    folder: async (path) => folders.includes(path),
  };
}

const mac = ["/Applications", "/Users/me/Applications", "/System/Applications/Utilities"];

test("macOS offers Terminal, Xcode and other bundle-only apps by their bundle", async () => {
  const apps = await installedApps({
    paths: "/usr/bin",
    platform: "darwin",
    locations: mac,
    probe: probe(
      [],
      [
        "/System/Applications/Utilities/Terminal.app",
        "/Applications/Xcode.app",
        "/Users/me/Applications/Warp.app",
      ],
    ),
  });
  expect(apps).toEqual({
    editors: [{ id: "xcode", name: "Xcode", command: "/Applications/Xcode.app" }],
    terminals: [
      { id: "terminal", name: "Terminal", command: "/System/Applications/Utilities/Terminal.app" },
      { id: "warp", name: "Warp", command: "/Users/me/Applications/Warp.app" },
    ],
  });
});

test("macOS prefers an app's own launcher in its bundle, so it opens at a line", async () => {
  const cli = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
  const apps = await installedApps({
    paths: "",
    platform: "darwin",
    locations: mac,
    probe: probe([cli], ["/Applications/Cursor.app", "/Applications/WebStorm.app"]),
  });
  expect(apps.editors).toEqual([
    { id: "cursor", name: "Cursor", command: cli },
    { id: "webstorm", name: "WebStorm", command: "/Applications/WebStorm.app" },
  ]);
});

test("macOS finds a JetBrains IDE under any of its edition names", async () => {
  const apps = await installedApps({
    paths: "",
    platform: "darwin",
    locations: mac,
    probe: probe([], ["/Applications/PyCharm CE.app"]),
  });
  expect(apps.editors).toEqual([
    { id: "pycharm", name: "PyCharm", command: "/Applications/PyCharm CE.app" },
  ]);
});

test("Linux finds terminals by their binaries on PATH and in Flatpak exports", async () => {
  const apps = await installedApps({
    paths: "/usr/bin",
    platform: "linux",
    locations: ["/var/lib/flatpak/exports/bin"],
    probe: probe(["/usr/bin/ptyxis", "/var/lib/flatpak/exports/bin/org.wezfurlong.wezterm"]),
  });
  expect(apps.terminals).toEqual([
    {
      id: "wezterm",
      name: "WezTerm",
      command: "/var/lib/flatpak/exports/bin/org.wezfurlong.wezterm",
    },
    { id: "ptyxis", name: "Ptyxis", command: "/usr/bin/ptyxis" },
  ]);
});

test("Linux never offers a macOS-only app, whatever is on PATH", async () => {
  const apps = await installedApps({
    paths: "/usr/bin",
    platform: "linux",
    probe: probe(["/usr/bin/Terminal.app", "/usr/bin/xcode"], ["/usr/bin/Xcode.app"]),
  });
  expect(apps).toEqual({ editors: [], terminals: [] });
});

// Windows paths written the host's way, since `path` here is the host's: what discovery reads is
// the same either way.
const local = "/c/Users/me/AppData/Local";

test("Windows finds Windows Terminal and VS Code Insiders by their own .exe", async () => {
  const wt = `${local}/Microsoft/WindowsApps/wt.exe`;
  const insiders = `${local}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe`;
  const apps = await installedApps({
    paths: "",
    platform: "win32",
    windows: { env: { LOCALAPPDATA: local }, appPath: async () => undefined },
    probe: probe([wt, insiders]),
  });
  expect(apps).toEqual({
    editors: [{ id: "code-insiders", name: "VS Code Insiders", command: insiders }],
    terminals: [{ id: "windows-terminal", name: "Windows Terminal", command: wt }],
  });
});

test("Windows takes a registered IDE only when it names that IDE's own .exe", async () => {
  const rider = "/c/JetBrains/Rider/bin/rider64.exe";
  const apps = await installedApps({
    paths: "",
    platform: "win32",
    windows: {
      env: {},
      appPath: async (exe) =>
        exe === "rider64.exe" ? rider : exe === "clion64.exe" ? "/c/x/payload.exe" : undefined,
    },
    probe: { runnable: async () => true, folder: async () => false },
  });
  expect(apps.editors).toEqual([{ id: "rider", name: "Rider", command: rider }]);
});
