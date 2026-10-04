import { expect, test } from "vitest";
import { unwrapShellCommand } from "@ace/provider-kit/shell-command";

test.each(["sh", "bash", "zsh", "dash", "fish"])(
  "decodes the %s wrapper without executing it",
  (shell) => {
    expect(unwrapShellCommand(`/usr/bin/${shell} -lc 'pwd'`)).toEqual({
      inner: "pwd",
      shell: `/usr/bin/${shell}`,
    });
  },
);
test("decodes standard embedded single quotes and preserves script whitespace", () => {
  expect(unwrapShellCommand("/bin/sh -c 'echo '\\''hello'\\''\n'")?.inner).toBe("echo 'hello'\n");
});
test.each([
  "sh -c 'pwd'",
  "/bin/zsh -l -c 'pwd'",
  "/bin/zsh -lc 'pwd' extra",
  '/bin/zsh -c "pwd"',
  "/bin/notsh -c 'pwd'",
  "/bin/zsh -c 'pwd'; echo unsafe",
  "/bin/zsh -c 'echo 'bad''",
  "/bin/zsh -c 'unterminated",
  "/bin/sh -xc 'pwd'",
  "/bin/sh -c 'pwd'\n",
])("leaves unsupported or ambiguous input unchanged: %s", (command) => {
  expect(unwrapShellCommand(command)).toBeUndefined();
});
