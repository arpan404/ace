import { win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { gitForWindowsBash } from "./git-for-windows-bash.ts";

/** A machine whose `git --exec-path` answers `execPath`, with Git for Windows at `root` (if any). */
function machine(execPath: string, root?: string, env: NodeJS.ProcessEnv = {}) {
  const files = new Set(
    root
      ? [win32.join(root, "bin", "bash.exe"), win32.join(root, "usr", "bin", "bash.exe")].map(
          (path) => path.toLowerCase(),
        )
      : [],
  );
  return {
    env,
    // git answers an inherited GIT_EXEC_PATH verbatim, as the real one does; Windows reads
    // environment names in any case.
    execPath: (asked: NodeJS.ProcessEnv) =>
      `${Object.entries(asked).find(([name]) => name.toUpperCase() === "GIT_EXEC_PATH")?.[1] ?? execPath}\n`,
    exists: (path: string) => files.has(path.toLowerCase()),
  };
}

describe("Git for Windows' bash is found for every supported install layout", () => {
  test.each([
    ["x64", "C:\\Program Files\\Git", "mingw64"],
    ["ARM64", "C:\\Program Files\\Git", "clangarm64"],
    ["32-bit", "C:\\Program Files (x86)\\Git", "mingw32"],
    ["UCRT", "D:\\Tools\\Git", "ucrt64"],
    ["portable", "E:\\PortableGit", "mingw64"],
    ["Scoop", "C:\\Users\\a user\\scoop\\apps\\git\\current", "mingw64"],
  ])("%s at %s", (_layout, root, arch) => {
    expect(gitForWindowsBash(machine(`${root}\\${arch}\\libexec\\git-core`, root))).toEqual({
      ok: true,
      bash: `${root}\\bin\\bash.exe`,
    });
  });

  test("forward slashes and a different case, as git prints them", () => {
    expect(
      gitForWindowsBash(
        machine("c:/Program Files/Git/CLANGARM64/libexec/git-core/", "c:\\Program Files\\Git"),
      ),
    ).toEqual({ ok: true, bash: "c:\\Program Files\\Git\\bin\\bash.exe" });
  });
});

test.each(["GIT_EXEC_PATH", "Git_Exec_Path"])(
  "an inherited %s does not choose the bash",
  (name) => {
    const root = "C:\\Program Files\\Git";
    // The override is a valid-looking layout whose bash files exist too.
    const elsewhere = "C:\\Users\\Public\\evil";
    const env = { [name]: `${elsewhere}\\mingw64\\libexec\\git-core`, Path: "x" };
    const lookup = machine(`${root}\\mingw64\\libexec\\git-core`, root, env);
    expect(gitForWindowsBash({ ...lookup, exists: () => true })).toEqual({
      ok: true,
      bash: `${root}\\bin\\bash.exe`,
    });
  },
);

describe("a git that is not Git for Windows is refused, naming it", () => {
  test.each([
    ["an MSYS2 or Cygwin git", "/usr/lib/git-core"],
    ["a relative path", "mingw64\\libexec\\git-core"],
    ["a git installed at a drive root", "C:\\mingw64\\libexec\\git-core"],
    ["an unknown toolchain folder", "C:\\Git\\clang64\\libexec\\git-core"],
    ["a different libexec folder", "C:\\Git\\mingw64\\lib\\git-core"],
  ])("%s (%s)", (_kind, execPath) => {
    // Every candidate bash exists, so only the exec path's shape can refuse it.
    const everything = { ...machine(execPath), exists: () => true };
    expect(gitForWindowsBash(everything)).toEqual({
      ok: false,
      error: `found git at ${execPath}, which is not Git for Windows; install Git for Windows or put its git first on PATH`,
    });
  });

  test("a Git for Windows layout without its bash files", () => {
    const execPath = "C:\\Program Files\\Git\\mingw64\\libexec\\git-core";
    expect(gitForWindowsBash(machine(execPath))).toMatchObject({ ok: false });
    const onlyLauncher = {
      ...machine(execPath),
      exists: (path: string) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
    };
    expect(gitForWindowsBash(onlyLauncher)).toMatchObject({ ok: false });
  });
});
