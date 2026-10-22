import { expect, test } from "vitest";
import { resolveShell } from "./shell.ts";
import { resolveShell as resolveViaPty } from "./pty.ts";

const WINDOWS_CMD = "C:\\Windows\\System32\\cmd.exe";

test("an explicit shell wins on Windows without consulting the environment", () => {
  const shell = resolveShell("C:\\custom\\shell.exe", {
    platform: "win32",
    env: { SHELL: "/bin/zsh", ComSpec: WINDOWS_CMD, SystemRoot: "C:\\Windows" },
    exists: () => false,
  });
  expect(shell).toBe("C:\\custom\\shell.exe");
});

test("Windows uses ComSpec and ignores POSIX SHELL", () => {
  const shell = resolveShell(undefined, {
    platform: "win32",
    env: { SHELL: "/bin/zsh", ComSpec: WINDOWS_CMD },
    exists: () => false,
  });
  expect(shell).toBe(WINDOWS_CMD);
});

test("Windows prefers ComSpec over a SystemRoot fallback", () => {
  const shell = resolveShell(undefined, {
    platform: "win32",
    env: { ComSpec: "D:\\tools\\cmd.exe", SystemRoot: "C:\\Windows" },
    exists: () => true,
  });
  expect(shell).toBe("D:\\tools\\cmd.exe");
});

test("Windows falls back to SystemRoot cmd when ComSpec is missing", () => {
  const shell = resolveShell(undefined, {
    platform: "win32",
    env: { SHELL: "/bin/bash", SystemRoot: "C:\\Windows" },
    exists: (path) => path === WINDOWS_CMD,
  });
  expect(shell).toBe(WINDOWS_CMD);
});

test("Windows accepts the uppercase COMSPEC and SYSTEMROOT spellings", () => {
  const viaComSpec = resolveShell(undefined, {
    platform: "win32",
    env: { COMSPEC: WINDOWS_CMD },
    exists: () => false,
  });
  expect(viaComSpec).toBe(WINDOWS_CMD);
  const viaSystemRoot = resolveShell(undefined, {
    platform: "win32",
    env: { SYSTEMROOT: "C:\\Windows" },
    exists: (path) => path === WINDOWS_CMD,
  });
  expect(viaSystemRoot).toBe(WINDOWS_CMD);
});

test("Windows matches ComSpec and SystemRoot case-insensitively", () => {
  const viaComSpec = resolveShell(undefined, {
    platform: "win32",
    env: { comspec: WINDOWS_CMD },
    exists: () => false,
  });
  expect(viaComSpec).toBe(WINDOWS_CMD);
  const viaSystemRoot = resolveShell(undefined, {
    platform: "win32",
    env: { systemroot: "C:\\Windows" },
    exists: (path) => path === WINDOWS_CMD,
  });
  expect(viaSystemRoot).toBe(WINDOWS_CMD);
});

test("Windows falls back to SystemRoot when ComSpec is empty", () => {
  const shell = resolveShell(undefined, {
    platform: "win32",
    env: { ComSpec: "", SystemRoot: "C:\\Windows" },
    exists: (path) => path === WINDOWS_CMD,
  });
  expect(shell).toBe(WINDOWS_CMD);
});

test("Windows rejects relative SystemRoot so fallback never depends on cwd", () => {
  for (const SystemRoot of ["Windows", "C:Windows", "\\Windows"]) {
    expect(() =>
      resolveShell(undefined, {
        platform: "win32",
        env: { SystemRoot },
        exists: () => true,
      }),
    ).toThrow("No login shell found");
  }
});

test("Windows throws instead of leaking POSIX SHELL when nothing resolves", () => {
  expect(() =>
    resolveShell(undefined, {
      platform: "win32",
      env: { SHELL: "/bin/bash", SystemRoot: "C:\\Windows" },
      exists: () => false,
    }),
  ).toThrow("No login shell found");
  expect(() => resolveShell(undefined, { platform: "win32", env: {}, exists: () => true })).toThrow(
    "No login shell found",
  );
});

test("POSIX keeps SHELL first and ignores ComSpec", () => {
  const shell = resolveShell(undefined, {
    platform: "linux",
    env: { SHELL: "/bin/fish", ComSpec: WINDOWS_CMD },
    exists: () => false,
  });
  expect(shell).toBe("/bin/fish");
});

test("POSIX falls back to the first executable shell", () => {
  const zsh = resolveShell(undefined, {
    platform: "darwin",
    env: {},
    exists: () => true,
  });
  expect(zsh).toBe("/bin/zsh");
  const bash = resolveShell(undefined, {
    platform: "linux",
    env: {},
    exists: (path) => path === "/bin/bash",
  });
  expect(bash).toBe("/bin/bash");
});

test("POSIX throws when no shell is available", () => {
  expect(() =>
    resolveShell(undefined, { platform: "linux", env: {}, exists: () => false }),
  ).toThrow("No login shell found");
});

test("the existing pty import path exposes the same selection seam", () => {
  const shell = resolveViaPty(undefined, {
    platform: "win32",
    env: { SHELL: "/bin/zsh", ComSpec: WINDOWS_CMD },
    exists: () => false,
  });
  expect(shell).toBe(WINDOWS_CMD);
});
