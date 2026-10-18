import { expect, test } from "vitest";
import { checkCliVersion } from "./cli-versions.ts";
import { checkCli, CliTooOldError, requireMinimum } from "./cli-requirements.ts";

test("each CLI's real --version output is read and compared with its minimum", () => {
  const outputs: [Parameters<typeof checkCli>[0], string, string][] = [
    ["claude", "2.1.286 (Claude Code)\n", "2.1.286"],
    ["codex", "codex-cli 0.159.1\n", "0.159.1"],
    ["opencode", "opencode v2.0.22\n", "2.0.22"],
    ["opencode", "v2.0.22", "2.0.22"],
    ["pi", "0.85.1\n", "0.85.1"],
    ["antigravity", "agy 1.2.3\n", "1.2.3"],
    ["gemini", "0.43.0\n", "0.43.0"],
    ["qwen-code", "0.0.14\n", "0.0.14"],
    ["cursor-sdk", "1.0.35", "1.0.35"],
  ];
  for (const [cli, output, installed] of outputs)
    expect(checkCli(cli, output)).toMatchObject({ status: "ok", installed });
});

test("a CLI below the minimum is too old and says which versions", () => {
  expect(checkCli("claude", "2.1.200 (Claude Code)")).toEqual({
    status: "too_old",
    installed: "2.1.200",
    required: "2.1.286",
  });
  expect(checkCli("codex", "codex-cli 0.158.9")).toMatchObject({ status: "too_old" });
  expect(checkCli("antigravity", "agy 1.1.1")).toMatchObject({
    status: "too_old",
    installed: "1.1.1",
    required: "1.2.1",
  });
  expect(checkCli("pi", "0.100.0")).toMatchObject({ status: "ok" });
  expect(checkCli("pi", "0.9.0")).toMatchObject({ status: "too_old" });
  expect(checkCli("pi", "0.85.0")).toMatchObject({ status: "too_old" });
});

test("a newer version, a new major line included, is never too old", () => {
  for (const output of ["2.1.287", "2.2.0", "3.0.0", "10.0.0-beta.1"])
    expect(checkCli("claude", output).status).toBe("ok");
  expect(checkCli("opencode", "opencode v2.1.0").status).toBe("ok");
  expect(checkCli("opencode", "3.0.0").status).toBe("ok");
});

test("a prerelease of the minimum is older than the minimum; one of a later release is not", () => {
  expect(checkCliVersion("2.1.286", "2.1.286-beta.1").status).toBe("too_old");
  expect(checkCliVersion("2.1.286", "2.1.287-alpha").status).toBe("ok");
  expect(checkCliVersion("0.162.0-alpha.2", "0.162.0-alpha.10").status).toBe("ok");
  expect(checkCliVersion("0.162.0-alpha.2", "0.162.0-alpha.1").status).toBe("too_old");
});

test("output without a version is unreadable, not too old", () => {
  for (const output of [undefined, "", "Claude Code", "command not found", "1.2.3.4"])
    expect(checkCli("claude", output)).toEqual({
      status: "unreadable",
      required: "2.1.286",
    });
  expect(() => requireMinimum("claude", "unknown")).not.toThrow();
});

test("starting below the minimum throws a typed error naming the CLI and both versions", () => {
  let caught: unknown;
  try {
    requireMinimum("claude", "2.1.200 (Claude Code)");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CliTooOldError);
  expect(caught).toMatchObject({
    code: "cli_too_old",
    cli: "claude",
    installed: "2.1.200",
    required: "2.1.286",
    message:
      "Claude Code 2.1.200 is older than 2.1.286, the oldest version ace supports. Update Claude Code, then refresh.",
  });
  expect(() => requireMinimum("claude", "2.1.286 (Claude Code)")).not.toThrow();
});
