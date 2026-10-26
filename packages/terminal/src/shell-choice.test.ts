import { expect, test } from "vitest";
import { resolveShell, resolveSleep, type ShellSelectionPorts } from "./pty.ts";

function host(
  installed: readonly string[],
  account: string | null,
  env: NodeJS.ProcessEnv = {},
): ShellSelectionPorts {
  return {
    platform: "linux",
    accountShell: () => account,
    env,
    exists: (path) => installed.includes(path),
  };
}

test("a daemon started without SHELL opens the account's login shell", () => {
  expect(resolveShell(undefined, host(["/usr/bin/fish", "/bin/bash"], "/usr/bin/fish"))).toBe(
    "/usr/bin/fish",
  );
});

test("SHELL from the session wins over the account's login shell", () => {
  expect(
    resolveShell(undefined, host(["/bin/zsh", "/bin/bash"], "/bin/bash", { SHELL: "/bin/zsh" })),
  ).toBe("/bin/zsh");
});

test("an account that may not log in falls back to bash, then sh", () => {
  expect(resolveShell(undefined, host(["/bin/bash", "/bin/sh"], "/usr/sbin/nologin"))).toBe(
    "/bin/bash",
  );
  expect(resolveShell(undefined, host(["/bin/sh"], "/run/missing/zsh"))).toBe("/bin/sh");
  expect(() => resolveShell(undefined, host([], null))).toThrow("No login shell found");
});

test("the terminal launcher finds sleep by absolute path, including NixOS's system profile", () => {
  expect(resolveSleep((path) => path === "/run/current-system/sw/bin/sleep")).toBe(
    "/run/current-system/sw/bin/sleep",
  );
  expect(resolveSleep((path) => path === "/usr/bin/sleep")).toBe("/usr/bin/sleep");
  expect(resolveSleep((path) => path === "/bin/sleep" || path === "/usr/bin/sleep")).toBe(
    "/bin/sleep",
  );
});
