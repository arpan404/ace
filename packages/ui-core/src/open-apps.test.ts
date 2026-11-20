import { describe, expect, test } from "vitest";
import { appLaunch, openApp } from "./open-apps.ts";

function app(id: string) {
  const found = openApp(id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

describe("opening a target in a catalogued app", () => {
  test.each([
    ["code", "/bin/code", ["-g", "/p/a.ts:7:2"]],
    ["zed", "/bin/zed", ["/p/a.ts:7:2"]],
    ["webstorm", "/bin/webstorm", ["--line", "7", "--column", "2", "/p/a.ts"]],
    ["fleet", "/bin/fleet", ["/p/a.ts"]],
  ])("%s takes the file at its line its own way", (id, command, args) => {
    expect(appLaunch(app(id), command, { path: "/p/a.ts", line: 7, column: 2 })).toEqual({
      command,
      args,
    });
  });

  test("a macOS bundle without a launcher opens through `open -a`, never run itself", () => {
    expect(appLaunch(app("xcode"), "/Applications/Xcode.app", { path: "/p", line: 3 })).toEqual({
      command: "/usr/bin/open",
      args: ["-a", "/Applications/Xcode.app", "/p"],
    });
  });

  test.each([
    ["wezterm", ["start", "--cwd", "/p dir"]],
    ["kitty", ["--directory", "/p dir"]],
    ["ptyxis", ["--new-window", "--working-directory=/p dir"]],
    ["gnome-terminal", ["--working-directory=/p dir"]],
    ["konsole", ["--workdir", "/p dir"]],
    ["windows-terminal", ["-d", "/p dir"]],
  ])("%s starts in the folder, which stays one argument", (id, args) => {
    expect(appLaunch(app(id), "/bin/term", { path: "/p dir" })).toEqual({
      command: "/bin/term",
      args,
    });
  });

  test("a terminal ignores a line: it only ever starts in a folder", () => {
    expect(appLaunch(app("alacritty"), "/bin/alacritty", { path: "/p", line: 4 })?.args).toEqual([
      "--working-directory",
      "/p",
    ]);
  });

  test("a terminal that can only open as a bundle gets nothing outside macOS", () => {
    expect(appLaunch(app("iterm"), "/usr/bin/iterm", { path: "/p" })).toBeUndefined();
  });
});
