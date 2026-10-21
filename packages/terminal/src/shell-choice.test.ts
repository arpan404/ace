import { expect, test } from "vitest";
import { resolveShell, type ShellHost } from "./pty.ts";

function host(
  installed: readonly string[],
  account: string | null,
  env: NodeJS.ProcessEnv = {},
): ShellHost {
  return { accountShell: () => account, env, executable: (path) => installed.includes(path) };
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
