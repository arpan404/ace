import { cliExitCodes, CliError } from "@ace/protocol/cli-output";
import { exitCodes } from "@ace/service/exit-codes";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { commandTable } from "./commands/table.ts";
import { complete, completionScript, currentShell, shells } from "./completion.ts";
import { aliasOutcome, aliasPhase, releasesSince } from "./deprecation.ts";
import { humanError, toCliError } from "./errors.ts";
import { canPrompt, outputMode, useColor, type Surroundings } from "./input-mode.ts";
import { CliFailure, usageFailure } from "./output.ts";

const table = commandTable();

describe("exit codes", () => {
  test.each([
    ["ok", 0],
    ["failed", 1],
    ["needs-human", 2],
    ["timeout", 3],
    ["refused", 4],
    ["uncertain", 5],
    ["address-in-use", 6],
    ["lock-held", 7],
    ["usage", 64],
    ["newer-data", 65],
    ["incompatible-data", 66],
  ] as const)("%s exits %i, the same number the desktop app reads", (name, code) => {
    expect(cliExitCodes[name]).toBe(code);
    expect(exitCodes[name]).toBe(code);
  });

  test.each([
    [usageFailure("THREAD must be a thread id."), "usage", "bad_argument"],
    [new CliFailure("refused", "No such thread."), "refused", "refused"],
    [
      new CliFailure("needs-human", "Sign in.", undefined, { code: "signed_out" }),
      "needs-human",
      "signed_out",
    ],
    [
      Object.assign(new Error("ENOENT: open '/h/daemon-endpoint'"), { code: "ENOENT" }),
      "refused",
      "daemon_down",
    ],
    [
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      "refused",
      "daemon_down",
    ],
    [clientError("timeout"), "timeout", "timeout"],
    [clientError("auth"), "refused", "refused"],
    [clientError("protocol"), "uncertain", "uncertain"],
    [zodError(), "usage", "bad_argument"],
    [new TypeError("x is undefined"), "failed", "internal"],
  ] as const)("%o reports as %s / %s", (error, status, code) => {
    const reported = CliError.parse(toCliError(error));
    expect(reported).toMatchObject({ ok: false, status, code });
  });
});

describe("error text", () => {
  test("the daemon being down reads as one sentence and the way out, never a file error", () => {
    const text = humanError(
      toCliError(Object.assign(new Error("ENOENT: open '/x/daemon-endpoint'"), { code: "ENOENT" })),
    );
    expect(text).toBe("✕ ace isn't running.\n  Start it with ace start, or open the app.\n");
  });

  test("a schema error becomes a sentence, not Zod's issue list", () => {
    const error = toCliError(zodError(), "thread.show");
    expect(error.error).not.toContain("[");
    expect(error.hint).toBe("See ace help thread show.");
  });

  test("an unexpected exception is ace's fault, not a refusal, and points at triage", () => {
    const error = toCliError(new RangeError("boom"));
    expect(error).toMatchObject({ status: "failed", hint: "Run ace triage to report it." });
  });

  test("an uncertain mutation prints the key to retry with", () => {
    const error = toCliError(
      new CliFailure(
        "uncertain",
        "ace didn't confirm whether it ran.",
        {},
        { idempotencyKey: "k-1" },
      ),
    );
    expect(error.retry).toEqual({ idempotencyKey: "k-1" });
    expect(error.hint).toContain("--idempotency-key k-1");
  });

  test("problems print under the sentence as path:line: message", () => {
    const text = humanError(
      toCliError(
        new CliFailure("failed", "The suit fails 1 check.", undefined, {
          problems: [{ path: "suit.json", line: 3, message: "The name is too long." }],
        }),
      ),
    );
    expect(text).toContain("  suit.json:3: The name is too long.\n");
  });
});

describe("who is on the other end", () => {
  const person: Surroundings = { flags: {}, env: {}, stdinTTY: true, stdoutTTY: true };
  test.each<[string, Surroundings, boolean]>([
    ["a person at a terminal", person, true],
    ["stdin is a pipe", { ...person, stdinTTY: false }, false],
    ["stdout is a pipe", { ...person, stdoutTTY: false }, false],
    ["--no-input", { ...person, flags: { "no-input": true } }, false],
    ["--json", { ...person, flags: { json: true } }, false],
    ["--quiet", { ...person, flags: { quiet: true } }, false],
    ["--jq", { ...person, flags: { jq: "." } }, false],
    ["ACE_NO_INPUT=1", { ...person, env: { ACE_NO_INPUT: "1" } }, false],
    ["ACE_NO_INPUT=0", { ...person, env: { ACE_NO_INPUT: "0" } }, true],
    ["an agent's shell (ACE_THREAD_ID)", { ...person, env: { ACE_THREAD_ID: "t1" } }, false],
  ])("%s may be asked: %s", (_name, at, expected) => {
    expect(canPrompt(at)).toBe(expected);
  });

  test.each([
    [{}, "human"],
    [{ json: true }, "json"],
    [{ jq: ".a" }, "json"],
    [{ stream: "jsonl" }, "json"],
    [{ quiet: true }, "quiet"],
    [{ quiet: true, json: true }, "json"],
  ] as const)("%o prints as %s", (flags, mode) => {
    expect(outputMode(flags)).toBe(mode);
  });

  test("colour only on a terminal, never against NO_COLOR, never in JSON", () => {
    expect(useColor(person)).toBe(true);
    expect(useColor({ ...person, stdoutTTY: false })).toBe(false);
    expect(useColor({ ...person, env: { NO_COLOR: "1" } })).toBe(false);
    expect(useColor({ ...person, flags: { json: true, color: "auto" } })).toBe(false);
    expect(useColor({ ...person, stdoutTTY: false, flags: { color: "always" } })).toBe(true);
  });
});

describe("old spellings retire on schedule", () => {
  const alias = { words: ["threads", "list"], deprecatedSince: "0.0.24" };
  test.each([
    ["development", "notice"],
    ["0.0.23", "notice"],
    ["0.0.24", "notice"],
    ["0.0.26", "notice"],
    ["0.0.27", "error"],
    ["0.0.28", "removed"],
    ["1.0.0", "removed"],
  ] as const)("in %s an old spelling is at %s", (version, phase) => {
    expect(aliasPhase(alias, version)).toBe(phase);
  });

  test("after 0.0.x, minor releases count", () => {
    expect(releasesSince("1.2.0", "1.4.9")).toBe(2);
  });

  const thread = table.byId.get("thread.list");
  test("the notice is for a person at a terminal only", () => {
    if (!thread) throw new Error("no thread.list");
    const at = (human: boolean, stderrTTY: boolean) =>
      aliasOutcome(alias, alias.words, thread, "0.0.24", { human, stderrTTY }).kind;
    expect(at(true, true)).toBe("notice");
    expect(at(true, false)).toBe("run");
    expect(at(false, true)).toBe("run");
  });

  test("once retired, the old spelling names the new one", () => {
    if (!thread) throw new Error("no thread.list");
    expect(
      aliasOutcome(alias, alias.words, thread, "0.0.27", { human: false, stderrTTY: false }),
    ).toEqual({
      kind: "refuse",
      code: "retired_command",
      text: "ace threads list is now ace thread list.",
      hint: "Run ace thread list instead.",
    });
  });
});

describe("completion", () => {
  test.each([
    [[":"], ["account", "chat", "completion"]],
    [[":thr"], ["thread"]],
    [
      ["thread", ":s"],
      ["send", "show", "start", "status", "steer", "stop"],
    ],
    [["thread", "list", ":--pro"], ["--project"]],
    [["thread", "show", "t1", ":"], []],
    [["market", ":maint"], []],
  ])("ace %j", (words, expected) => {
    const candidates = complete(table, words);
    for (const word of expected) expect(candidates).toContain(word);
    if (expected.length === 0) expect(candidates).toEqual([]);
  });

  test("old spellings and hidden commands are never offered", () => {
    const top = complete(table, [":"]);
    for (const word of ["threads", "kill-all", "support-bundle", "supervise", "__complete"])
      expect(top).not.toContain(word);
  });

  test.each(shells)("the %s script asks ace __complete and nothing else", (shell) => {
    expect(completionScript(shell)).toContain("ace __complete --");
  });

  test("the shell comes from $SHELL, or PowerShell on Windows", () => {
    expect(currentShell({ SHELL: "/bin/zsh" }, "darwin")).toBe("zsh");
    expect(currentShell({ SHELL: "/usr/bin/fish" }, "linux")).toBe("fish");
    expect(currentShell({}, "win32")).toBe("powershell");
    expect(currentShell({ SHELL: "/bin/tcsh" }, "linux")).toBeUndefined();
  });
});

function clientError(code: string): Error {
  return Object.assign(new Error(code), { name: "ClientError", code });
}

function zodError(): unknown {
  const parsed = z.string().regex(/^t_/).safeParse("nope");
  return parsed.success ? undefined : parsed.error;
}
