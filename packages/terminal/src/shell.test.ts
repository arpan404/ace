import { expect, test } from "vitest";
import { resolveShell } from "./pty.ts";

const WINDOWS_CMD = "C:\\Windows\\System32\\cmd.exe";

test("an explicit shell wins on Windows without consulting the environment", () => {
  const shell = resolveShell("C:\\custom\\shell.exe", {
    platform: "win32",
    env: { SHELL: "/bin/zsh", ComSpec: WINDOWS_CMD, SystemRoot: "C:\\Windows" },
    exists: () => false,
  });
  expect(shell).toBe("C:\\custom\\shell.exe");
});

test("Windows prefers pwsh over powershell and ComSpec", () => {
  const shell = resolveShell(undefined, {
    platform: "win32",
    env: { ComSpec: WINDOWS_CMD },
    exists: () => false,
    findExecutable: (command: string) =>
      command === "pwsh" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : undefined,
  });
  expect(shell).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
});

test("Windows falls back to powershell when pwsh is missing", () => {
  const shell = resolveShell(undefined, {
    platform: "win32",
    env: { ComSpec: WINDOWS_CMD },
    exists: () => false,
    findExecutable: (command: string) =>
      command === "powershell"
        ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : undefined,
  });
  expect(shell).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("Windows falls back to ComSpec when no PowerShell is found", () => {
  const shell = resolveShell(undefined, {
    platform: "win32",
    env: { SHELL: "/bin/zsh", ComSpec: WINDOWS_CMD },
    exists: () => false,
    findExecutable: () => undefined,
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
