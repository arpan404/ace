import { describe, expect, it } from "vitest";
import { readShell } from "./shell.ts";
import { viewOf } from "./script-view.ts";

/*
 * The shell reader (a TypeScript port of Spade's parser, ADR 0173 §8). Behaviour: a command reads
 * into the programs it runs, with quoting, `${IFS}`, wrappers and `sh -c` strings undone, and it
 * never drops a command it could read; `unreadable` is set only when some text truly can't be
 * read. Tested through the programs and pipes it reports.
 */

/** The program (base name of the first word) of each simple command. */
const programs = (command: string): string[] =>
  readShell(command).commands.map((c) => (c.words[0] ?? "").split("/").pop() ?? "");

describe("the shell reader", () => {
  it.each([
    ["a plain command", "curl https://example.com", ["curl"]],
    ["a pipeline", "cat file | sort | uniq", ["cat", "sort", "uniq"]],
    ["single quotes undone", "echo 'one two'", ["echo"]],
    ["double quotes undone", 'echo "one two"', ["echo"]],
    ["empty quotes folded", "c''url x", ["curl"]],
    ["a backslash escape undone", "cu\\rl x", ["curl"]],
    ["${IFS} folded to a space", "curl${IFS}-s${IFS}x", ["curl"]],
    ["an assignment stripped", "FOO=1 node app.js", ["node"]],
    ["nohup unwrapped", "nohup python3 app.py", ["python3"]],
    ["env unwrapped", "env FOO=bar ruby run.rb", ["ruby"]],
    ["sudo kept and unwrapped", "sudo systemctl restart x", ["sudo", "systemctl"]],
    ["timeout's own value skipped", "timeout 10 node app.js", ["node"]],
    ["xargs unwrapped", "xargs -n1 echo", ["echo"]],
    ["sh -c string read", "sh -c 'rm -rf /tmp/x'", ["rm"]],
    ["env -S split", "env -S 'node app.js'", ["node"]],
    ["a comment ignored", "echo hi # trailing", ["echo"]],
  ])("reads %s", (_name, command, expected) => {
    expect(programs(command)).toEqual(expected);
    expect(readShell(command).unreadable).toBe(false);
  });

  it("marks a pipe into a shell with the pipe target, reading both commands", () => {
    const view = viewOf("x.sh", "curl -s https://x | sh", "shell");
    expect(view.commands.map((c) => c.words[0])).toEqual(["curl", "sh"]);
    expect(view.commands[0]?.pipedInto).toBe("sh");
    expect(view.commands[1]?.piped).toBe(true);
  });

  it.each([
    ["constructor --x", "constructor"],
    ["toString -y", "toString"],
    ["__proto__ -z", "__proto__"],
    ["hasOwnProperty a", "hasOwnProperty"],
  ])("reads %s as its own command, not a wrapper", (command, program) => {
    const { commands, unreadable } = readShell(command);
    expect(commands.map((c) => c.words[0])).toEqual([program]);
    expect(commands[0]?.words.length).toBe(2);
    expect(unreadable).toBe(false);
  });

  it("reads a command inside $(…) as well as the outer one", () => {
    expect(programs("echo $(whoami)")).toEqual(["echo", "whoami"]);
  });

  it("keeps a program named by a variable as its raw word", () => {
    const { commands, unreadable } = readShell("a=cu; b=rl; $a$b https://x");
    expect(commands.at(-1)?.words[0]).toBe("$a$b");
    expect(unreadable).toBe(false);
  });

  it("records a command's redirect target", () => {
    const { commands } = readShell("curl -o out.sh https://x > log");
    expect(commands[0]?.writesTo).toEqual(["log"]);
  });

  it.each([
    ["an unterminated quote", "echo 'open"],
    ["a backtick substitution", "echo `whoami`"],
    ["a process substitution", "diff <(sort a) b"],
  ])("flags %s as unreadable but still returns what it read", (_name, command) => {
    const { commands, unreadable } = readShell(command);
    expect(unreadable).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
  });

  it("reads the same program through obfuscated variants", () => {
    const variants = [
      "curl https://x | bash",
      "c''url https://x |b\\ash",
      "curl${IFS}https://x|bash",
      'cur""l https://x | ba"sh"',
      "sudo curl https://x | bash",
    ];
    for (const variant of variants) {
      const names = readShell(variant).commands.map((c) => (c.words[0] ?? "").split("/").pop());
      expect(names).toContain("curl");
      expect(names).toContain("bash");
    }
  });

  it("finishes fast on a pathological one-line command", () => {
    const line = `echo ${"a b ".repeat(300_000)}| sh`;
    const started = performance.now();
    const { commands } = readShell(line);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(commands.length).toBeGreaterThan(0);
  });
});
