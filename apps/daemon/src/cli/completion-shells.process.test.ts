import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { completionScript } from "./completion.ts";

// Each completion script runs in its real shell, the only place its `value<TAB>description`
// handling can be checked: a fake `ace` on PATH answers `__complete` for the line
// `ace thread show t_`. A shell this machine lacks is skipped.
const dir = mkdtempSync(join(tmpdir(), "ace-completion-shells-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fake = join(dir, "ace");
writeFileSync(
  fake,
  `#!/bin/sh
[ "$*" = "__complete -- thread show :t_" ] || { echo "unexpected: $*"; exit 0; }
printf 't_9f2c41\\tFix the login page\\nt_a01b22\\tAdd: retry tests\\nt_:odd\\tA colon in the value\\nt_plain\\n'
`,
);
chmodSync(fake, 0o755);
const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };

function has(shell: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${shell}`], { env }).status === 0;
}

function run(shell: string, args: string[], name: string, script: string): string[] {
  const path = join(dir, name);
  writeFileSync(path, script);
  const result = spawnSync(shell, [...args, path], { env, encoding: "utf8", timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

describe("completion scripts in their shells", () => {
  test.skipIf(!has("bash"))("bash offers the values alone", () => {
    const lines = run(
      "bash",
      ["--norc", "--noprofile"],
      "bash.sh",
      `${completionScript("bash")}
COMP_WORDS=(ace thread show t_)
COMP_CWORD=3
_ace
printf '%s\\n' "\${COMPREPLY[@]}"
`,
    );
    expect(lines).toEqual(["t_9f2c41", "t_a01b22", "t_:odd", "t_plain"]);
  });

  test.skipIf(!has("zsh"))("zsh describes each value, escaping a colon in it", () => {
    const lines = run(
      "zsh",
      ["-f"],
      "zsh.zsh",
      `compdef() { :; }
_describe() { print -rl -- "\${(@P)2}"; }
${completionScript("zsh")}
words=(ace thread show t_)
CURRENT=4
_ace
`,
    );
    expect(lines).toEqual([
      "t_9f2c41:Fix the login page",
      "t_a01b22:Add: retry tests",
      "t_\\:odd:A colon in the value",
      "t_plain",
    ]);
  });

  test.skipIf(!has("fish"))("fish shows each description beside its value", () => {
    const lines = run(
      "fish",
      ["--no-config"],
      "fish.fish",
      `${completionScript("fish")}
complete -C "ace thread show t_"
`,
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "t_9f2c41\tFix the login page",
        "t_a01b22\tAdd: retry tests",
        "t_plain",
      ]),
    );
  });

  test.skipIf(!has("pwsh"))("PowerShell gives each value its description as the tooltip", () => {
    const lines = run(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File"],
      "pwsh.ps1",
      `${completionScript("powershell")}
$line = 'ace thread show t_'
(TabExpansion2 -inputScript $line -cursorColumn $line.Length).CompletionMatches |
  ForEach-Object { $_.CompletionText + '|' + $_.ToolTip }
`,
    );
    expect(lines).toEqual([
      "t_9f2c41|Fix the login page",
      "t_a01b22|Add: retry tests",
      "t_:odd|A colon in the value",
      "t_plain|t_plain",
    ]);
  });
});
