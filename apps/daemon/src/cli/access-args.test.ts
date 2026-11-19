import { expect, test } from "vitest";
import { cliExitCodes } from "@ace/protocol/cli-output";
import { toCliError } from "./errors.ts";
import { grantLifetimeMs } from "./mcp.ts";
import { registryValues } from "./provider-accounts.ts";
import { providerArgument } from "./providers.ts";

function usage(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return toCliError(error);
  }
  throw new Error("expected a failure");
}

test.each([
  ["codex", "codex"],
  ["Claude", "claude"],
  [" antigravity ", "antigravity"],
  ["pi", "pi"],
])("PROVIDER %j names %s", (word, provider) => {
  expect(providerArgument(word)).toBe(provider);
});

test.each([["acp"], ["gemini"], [undefined]])(
  "PROVIDER %j is a usage error naming the choices",
  (word) => {
    const error = usage(() => providerArgument(word));
    expect(cliExitCodes[error.status]).toBe(64);
    expect(error.argument).toBe("PROVIDER");
    expect(error.error).toMatch(/codex, claude, cursor, opencode, antigravity or pi/);
  },
);

test.each([
  ["30m", 30 * 60_000],
  ["12h", 12 * 3_600_000],
  ["30d", 30 * 86_400_000],
  ["never", null],
])("--ttl %s is %s ms", (value, ms) => {
  expect(grantLifetimeMs(value)).toBe(ms);
});

test.each([["0d"], ["1w"], ["soon"]])("--ttl %s is a usage error", (value) => {
  const error = usage(() => grantLifetimeMs(value));
  expect(error).toMatchObject({ status: "usage", argument: "--ttl" });
});

test("the account registry's lines read back as values; a stray line is kept as a message", () => {
  expect(registryValues('{"ok":true}\nCursor SDK sign-in: https://x\n\n[1,2]\n')).toEqual([
    { ok: true },
    { message: "Cursor SDK sign-in: https://x" },
    [1, 2],
  ]);
});
