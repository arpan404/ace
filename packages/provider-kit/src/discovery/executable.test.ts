import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findExecutable, findWindowsExecutableSync } from "./executable.ts";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "ace-executable-"));
  directories.push(path);
  return path;
}
async function file(root: string, name: string, mode: 0o755 | 0o644 = 0o755) {
  const path = join(root, name);
  await writeFile(path, "stand-in");
  await chmod(path, mode);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Windows executable lookup", () => {
  it("resolves a bare command to its PATHEXT match", async () => {
    const root = await directory();
    const expected = await file(root, "claude.exe");
    expect(await findExecutable("claude", { PATH: root }, "win32")).toBe(expected);
  });

  it("prefers the PATHEXT match over an extensionless shim", async () => {
    const root = await directory();
    await file(root, "claude");
    const expected = await file(root, "claude.cmd");
    expect(await findExecutable("claude", { PATH: root }, "win32")).toBe(expected);
  });

  it("ignores an extensionless file without a PATHEXT match", async () => {
    const root = await directory();
    await file(root, "plain");
    expect(await findExecutable("plain", { PATH: root }, "win32")).toBeUndefined();
  });

  it("treats existence as runnable without the executable bit", async () => {
    const root = await directory();
    const expected = await file(root, "codex.cmd", 0o644);
    expect(await findExecutable("codex", { PATH: root }, "win32")).toBe(expected);
    expect(await findExecutable("codex", { PATH: root }, "darwin")).toBeUndefined();
  });

  it("tries PATHEXT entries in order within each directory", async () => {
    const root = await directory();
    await file(root, "tool.cmd");
    await file(root, "tool.exe");
    expect(await findExecutable("tool", { PATH: root, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(
      join(root, "tool.exe"),
    );
    expect(await findExecutable("tool", { PATH: root, PATHEXT: ".CMD;.EXE" }, "win32")).toBe(
      join(root, "tool.cmd"),
    );
  });

  it("falls back to .COM;.EXE;.BAT;.CMD when PATHEXT is unset", async () => {
    const root = await directory();
    const expected = await file(root, "agent.bat");
    expect(await findExecutable("agent", { PATH: root }, "win32")).toBe(expected);
  });

  it("reads PATH and PATHEXT without regard to key case", async () => {
    const root = await directory();
    const expected = await file(root, "npm.cmd");
    expect(await findExecutable("npm", { Path: root, pathext: ".CMD" }, "win32")).toBe(expected);
  });

  it("leaves a command that already names an extension alone", async () => {
    const root = await directory();
    await file(root, "shim.tool.exe");
    expect(await findExecutable("shim.tool", { PATH: root }, "win32")).toBeUndefined();
    const expected = await file(root, "shim.exe");
    expect(await findExecutable("shim.exe", { PATH: root }, "win32")).toBe(expected);
  });

  it("prefers the first PATH directory and skips empty entries", async () => {
    const first = await directory();
    const second = await directory();
    const expected = await file(first, "tool.exe");
    await file(second, "tool.exe");
    expect(await findExecutable("tool", { PATH: `;${first};${second}` }, "win32")).toBe(expected);
  });

  it("skips directories that collide with the executable name", async () => {
    const first = await directory();
    const second = await directory();
    await mkdir(join(first, "tool.exe"));
    const expected = await file(second, "tool.exe");
    expect(await findExecutable("tool", { PATH: [first, second].join(";") }, "win32")).toBe(
      expected,
    );
  });

  it("does not search PATH for commands containing a separator", async () => {
    const root = await directory();
    await mkdir(join(root, "sub"));
    await file(join(root, "sub"), "tool.bat");
    expect(await findExecutable("sub/tool", { PATH: root }, "win32")).toBeUndefined();
    expect(await findExecutable(join(root, "sub/tool"), { PATH: "" }, "win32")).toBe(
      join(root, "sub", "tool.bat"),
    );
  });

  it("resolves an absolute path with PATHEXT", async () => {
    const root = await directory();
    const expected = await file(root, "tool.cmd");
    expect(await findExecutable(join(root, "tool"), { PATH: "" }, "win32")).toBe(expected);
  });
});

describe("POSIX executable lookup", () => {
  it("ignores PATHEXT matches and requires the executable bit", async () => {
    const root = await directory();
    await file(root, "codex.exe");
    await file(root, "plain", 0o644);
    expect(await findExecutable("codex", { PATH: root }, "darwin")).toBeUndefined();
    expect(await findExecutable("plain", { PATH: root }, "darwin")).toBeUndefined();
    const expected = await file(root, "claude");
    expect(await findExecutable("claude", { PATH: root }, "darwin")).toBe(expected);
  });
});

function withCwd<T>(cwd: string, run: () => T): T {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
}

describe("Windows sync executable lookup", () => {
  it("resolves a bare command to its PATHEXT match without async", async () => {
    const root = await directory();
    const expected = await file(root, "pwsh.exe");
    expect(findWindowsExecutableSync("pwsh", { PATH: root })).toBe(expected);
  });

  it("prefers the PATHEXT match over an extensionless shim", async () => {
    const root = await directory();
    await file(root, "powershell");
    const expected = await file(root, "powershell.exe");
    expect(findWindowsExecutableSync("powershell", { PATH: root })).toBe(expected);
  });

  it("tries PATHEXT entries in order within each directory", async () => {
    const root = await directory();
    await file(root, "tool.cmd");
    await file(root, "tool.exe");
    expect(findWindowsExecutableSync("tool", { PATH: root, PATHEXT: ".EXE;.CMD" })).toBe(
      join(root, "tool.exe"),
    );
    expect(findWindowsExecutableSync("tool", { PATH: root, PATHEXT: ".CMD;.EXE" })).toBe(
      join(root, "tool.cmd"),
    );
  });

  it("reads PATH and PATHEXT without regard to key case", async () => {
    const root = await directory();
    const expected = await file(root, "pwsh.cmd");
    expect(findWindowsExecutableSync("pwsh", { Path: root, pathext: ".CMD" })).toBe(expected);
  });

  it("matches the async result for an absolute path with PATHEXT", async () => {
    const root = await directory();
    const expected = await file(root, "tool.cmd");
    const command = join(root, "tool");
    expect(findWindowsExecutableSync(command, { PATH: "" })).toBe(expected);
    await expect(findExecutable(command, { PATH: "" }, "win32")).resolves.toBe(expected);
  });

  it("rejects relative PATH entries so the cwd cannot win", async () => {
    const root = await directory();
    await mkdir(join(root, "sub"));
    await file(join(root, "sub"), "tool.exe");
    withCwd(root, () => {
      expect(findWindowsExecutableSync("tool", { PATH: "sub" })).toBeUndefined();
    });
    expect(findWindowsExecutableSync("tool", { PATH: join(root, "sub") })).toBe(
      join(root, "sub", "tool.exe"),
    );
  });

  it("does not resolve a bare name via the cwd when PATH is empty", async () => {
    const root = await directory();
    await file(root, "tool.exe");
    withCwd(root, () => {
      expect(findWindowsExecutableSync("tool", { PATH: "" })).toBeUndefined();
    });
  });
});
