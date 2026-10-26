import { test, expect } from "vitest";
import { ownedTree } from "./process-tree.ts";

/** The command line a Windows spawn would receive; nothing is spawned. */
function onWindows(command: string, args: string[]) {
  const tree = ownedTree(command, args, { platform: "win32" });
  return {
    command: tree.command,
    args: tree.args,
    verbatim:
      "windowsVerbatimArguments" in tree.spawnOptions && tree.spawnOptions.windowsVerbatimArguments,
  };
}

test("POSIX commands spawn as given in their own process group", () => {
  const tree = ownedTree("/usr/bin/agent.cmd", ["a&b"], { platform: "linux" });
  expect([tree.command, tree.args, tree.spawnOptions]).toEqual([
    "/usr/bin/agent.cmd",
    ["a&b"],
    { detached: true },
  ]);
});

test("Windows non-batch commands pass through without verbatim spawning", () => {
  expect(onWindows("C:\\tools\\agent.exe", ["--stdio"])).toEqual({
    command: "C:\\tools\\agent.exe",
    args: ["--stdio"],
    verbatim: false,
  });
  expect(onWindows("C:\\dir.cmd\\tool.exe", [])).toEqual({
    command: "C:\\dir.cmd\\tool.exe",
    args: [],
    verbatim: false,
  });
  expect(onWindows("tool.cmdx", ["a&b"])).toEqual({
    command: "tool.cmdx",
    args: ["a&b"],
    verbatim: false,
  });
});

test("batch entrypoints spawn verbatim through cmd.exe whatever the extension case", () => {
  expect(onWindows("cursor-agent.cmd", [])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""cursor-agent.cmd""'],
    verbatim: true,
  });
  expect(onWindows("C:\\tools\\run.BAT", [])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\tools\\run.BAT""'],
    verbatim: true,
  });
});

test("a path with spaces rides in plain quotes while its flag is escaped twice", () => {
  expect(onWindows("C:\\Program Files\\agent\\run.cmd", ["--stdio"])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\Program Files\\agent\\run.cmd" ^^^"--stdio^^^""'],
    verbatim: true,
  });
});

test("percent signs survive both cmd parses without expanding", () => {
  expect(onWindows("tool.cmd", ["%PATH%", "100%"])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"^^^%PATH^^^%^^^" ^^^"100^^^%^^^""'],
    verbatim: true,
  });
});

test("an ampersand stays inside its doubly escaped quotes", () => {
  expect(onWindows("tool.cmd", ["a&b"])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"a^^^&b^^^""'],
    verbatim: true,
  });
});

test("an embedded quote cannot flip cmd out of its quoted span", () => {
  expect(onWindows("tool.cmd", ['say "hi" & echo pwned'])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"say \\^^^"hi\\^^^" ^^^& echo pwned^^^""'],
    verbatim: true,
  });
});

test("a trailing backslash is doubled before the closing quote", () => {
  expect(onWindows("tool.cmd", ["C:\\my dir\\"])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"C:\\my dir\\\\^^^""'],
    verbatim: true,
  });
});

test("an empty argument still arrives as one argument", () => {
  expect(onWindows("tool.cmd", [""])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"^^^""'],
    verbatim: true,
  });
});

test("a command path containing % is refused", () => {
  expect(() => onWindows("C:\\%TOOLS%\\run.cmd", [])).toThrow("Windows batch command path");
});
