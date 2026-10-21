import { test, expect } from "vitest";
import { toWindowsCommand } from "./windows-command.ts";

test("non-batch commands pass through without verbatim spawning", () => {
  expect(toWindowsCommand("C:\\tools\\agent.exe", ["--stdio"])).toEqual({
    command: "C:\\tools\\agent.exe",
    args: ["--stdio"],
    verbatim: false,
  });
  expect(toWindowsCommand("C:\\dir.cmd\\tool.exe", [])).toEqual({
    command: "C:\\dir.cmd\\tool.exe",
    args: [],
    verbatim: false,
  });
  expect(toWindowsCommand("tool.cmdx", ["a&b"])).toEqual({
    command: "tool.cmdx",
    args: ["a&b"],
    verbatim: false,
  });
});

test("batch entrypoints spawn verbatim through cmd.exe whatever the extension case", () => {
  expect(toWindowsCommand("cursor-agent.cmd", [])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""cursor-agent.cmd""'],
    verbatim: true,
  });
  expect(toWindowsCommand("C:\\tools\\run.BAT", [])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\tools\\run.BAT""'],
    verbatim: true,
  });
});

test("a path with spaces rides in plain quotes while its flag is escaped twice", () => {
  expect(toWindowsCommand("C:\\Program Files\\agent\\run.cmd", ["--stdio"])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\Program Files\\agent\\run.cmd" ^^^"--stdio^^^""'],
    verbatim: true,
  });
});

test("percent signs survive both cmd parses without expanding", () => {
  expect(toWindowsCommand("tool.cmd", ["%PATH%", "100%"])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"^^^%PATH^^^%^^^" ^^^"100^^^%^^^""'],
    verbatim: true,
  });
});

test("an ampersand stays inside its doubly escaped quotes", () => {
  expect(toWindowsCommand("tool.cmd", ["a&b"])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"a^^^&b^^^""'],
    verbatim: true,
  });
});

test("an embedded quote cannot flip cmd out of its quoted span", () => {
  expect(toWindowsCommand("tool.cmd", ['say "hi" & echo pwned'])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"say \\^^^"hi\\^^^" ^^^& echo pwned^^^""'],
    verbatim: true,
  });
});

test("a trailing backslash is doubled before the closing quote", () => {
  expect(toWindowsCommand("tool.cmd", ["C:\\my dir\\"])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"C:\\my dir\\\\^^^""'],
    verbatim: true,
  });
});

test("an empty argument still arrives as one argument", () => {
  expect(toWindowsCommand("tool.cmd", [""])).toEqual({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '""tool.cmd" ^^^"^^^""'],
    verbatim: true,
  });
});

test("a command path containing % is refused", () => {
  expect(() => toWindowsCommand("C:\\%TOOLS%\\run.cmd", [])).toThrow("Windows batch command path");
});
