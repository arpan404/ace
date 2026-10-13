import { expect, it } from "vitest";
import { cliShimCheck, planCliShim, renderCliShim } from "./cli-shim.ts";

const windowsApp = {
  node: "C:\\Program Files\\ace\\resources\\runtime\\bin\\node.exe",
  entry: "C:\\Program Files\\ace\\resources\\daemon\\ace.mjs",
};

it("refreshes an ace.cmd ace wrote for an older install but never a person's own ace.cmd", () => {
  const current = renderCliShim(windowsApp, "win32");
  const older = renderCliShim(
    { node: "D:\\old\\runtime\\bin\\node.exe", entry: "D:\\old\\daemon\\ace.mjs" },
    "win32",
  );
  const own = "@echo off\r\nnode C:\\tools\\ace.mjs %*\r\n";
  expect(planCliShim({ kind: "file", content: older, executable: true }, current)).toBe("replace");
  expect(planCliShim({ kind: "file", content: current, executable: true }, current)).toBe(
    "unchanged",
  );
  expect(planCliShim({ kind: "file", content: own, executable: true }, current)).toBe("foreign");
});

it("refuses an install path that cmd would expand or cut short instead of writing a broken ace.cmd", () => {
  expect(() =>
    renderCliShim({ ...windowsApp, entry: "C:\\Users\\%USERNAME%\\ace\\ace.mjs" }, "win32"),
  ).toThrow(/Unsupported path/);
  expect(() => renderCliShim({ ...windowsApp, node: 'C:\\a"b\\node.exe' }, "win32")).toThrow(
    /Unsupported path/,
  );
});

it("rewrites a current shim that lost its executable bit", () => {
  const shim = renderCliShim({ node: "/a/node", entry: "/a/ace.mjs" }, "darwin");
  expect(planCliShim({ kind: "file", content: shim, executable: false }, shim)).toBe("replace");
});

it("lists a command left unreachable from a terminal, but stays quiet once PATH finds it", () => {
  const installed = {
    state: "unchanged",
    file: "/Users/a/.ace/bin/ace",
    directory: "/Users/a/.ace/bin",
  } as const;
  expect(cliShimCheck({ ...installed, onPath: false })).toMatchObject({
    id: "desktop.cli-path",
    status: "warn",
    fix: expect.stringContaining("/Users/a/.ace/bin"),
  });
  expect(cliShimCheck({ ...installed, onPath: true })).toBeUndefined();
});
