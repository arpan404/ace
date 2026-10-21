import { describe, expect, it } from "vitest";
import { toWindowsCommand } from "./windows-command.ts";

describe("Windows batch wrapping", () => {
  it("leaves non-batch commands alone", () => {
    expect(toWindowsCommand("C:\\tools\\agent.exe", ["--stdio"])).toEqual({
      command: "C:\\tools\\agent.exe",
      args: ["--stdio"],
    });
    expect(toWindowsCommand("C:\\dir.cmd\\tool.exe", [])).toEqual({
      command: "C:\\dir.cmd\\tool.exe",
      args: [],
    });
    expect(toWindowsCommand("tool.cmdx", ["a&b"])).toEqual({
      command: "tool.cmdx",
      args: ["a&b"],
    });
  });

  it("routes .cmd and .bat through cmd.exe regardless of extension case", () => {
    expect(toWindowsCommand("cursor-agent.cmd", [])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"cursor-agent.cmd"'],
    });
    expect(toWindowsCommand("C:\\tools\\run.BAT", [])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\tools\\run.BAT"'],
    });
  });

  it("quotes paths with spaces and leaves plain flags alone", () => {
    expect(toWindowsCommand("C:\\Program Files\\agent\\run.cmd", ["--stdio", "serve"])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\agent\\run.cmd" --stdio serve"'],
    });
  });

  it("keeps shell metacharacters literal inside quotes", () => {
    expect(toWindowsCommand("tool.cmd", ["a&b", "a^b", "a|b", "a<b>c", "x=1", "a;b"])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"tool.cmd "a&b" "a^b" "a|b" "a<b>c" "x=1" "a;b""'],
    });
  });

  it("doubles percent signs so %PATH% is not expanded", () => {
    expect(toWindowsCommand("tool.cmd", ["%PATH%", "100%"])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"tool.cmd "%%PATH%%" "100%%""'],
    });
  });

  it("escapes embedded quotes MSVCRT-style", () => {
    expect(toWindowsCommand("tool.cmd", ['say "hi"'])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"tool.cmd "say \\"hi\\"""'],
    });
  });

  it("doubles backslashes before a quote and at the end", () => {
    expect(toWindowsCommand("tool.cmd", ["C:\\my dir\\", 'a\\"b'])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"tool.cmd "C:\\my dir\\\\" "a\\\\\\"b""'],
    });
  });

  it("quotes an empty argument", () => {
    expect(toWindowsCommand("tool.cmd", [""])).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"tool.cmd """'],
    });
  });
});
