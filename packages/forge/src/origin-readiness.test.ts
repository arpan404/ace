import { expect, test } from "vitest";
import type { CommandRunner } from "./command.ts";
import { originReadiness } from "./origin-readiness.ts";
import { ForgeError } from "./errors.ts";

const preferences = {
  hosts: [{ host: "origin.cursor.com", forge: "origin" as const }],
  host: "origin.cursor.com",
  remote: "origin",
};
const signal = () => new AbortController().signal;
function runner(account: unknown): CommandRunner {
  return async (request) => {
    if (request.command !== "origin") throw new Error("Wrong CLI");
    if (request.args[0] === "--version")
      return { code: 0, stdout: "origin version 0.8.0", truncated: false };
    if (request.args.join(" ") === "api /namespaces --method GET")
      return { code: 0, stdout: JSON.stringify({ namespaces: [] }), truncated: false };
    if (request.args.join(" ") !== "auth status --json account")
      throw new Error("Credential or mutation command is forbidden");
    return { code: 0, stdout: JSON.stringify({ account }), truncated: false };
  };
}
test.each(["person@example.com", { email: "person@example.com" }])(
  "Origin verifies only its nonsecret account field",
  async (account) => {
    expect(await originReadiness(runner(account), preferences, signal())).toMatchObject({
      account: "person@example.com",
      api: "ready",
      cli: "available",
    });
  },
);
test("Origin reports expected-account mismatch without changing CLI authentication", async () => {
  const configured = {
    ...preferences,
    hosts: [{ host: "origin.cursor.com", forge: "origin" as const, account: "other@example.com" }],
  };
  expect(await originReadiness(runner("person@example.com"), configured, signal())).toMatchObject({
    api: "account_mismatch",
  });
});
test("a missing Origin CLI is unavailable", async () => {
  expect(
    await originReadiness(
      async () => {
        throw new ForgeError("cli");
      },
      preferences,
      signal(),
    ),
  ).toMatchObject({ cli: "unavailable", api: "unavailable" });
});
test("malformed Origin identity never becomes ready or leaks output", async () => {
  const status = await originReadiness(runner({ secret: "private" }), preferences, signal());
  expect(status.api).toBe("unavailable");
  expect(JSON.stringify(status)).not.toContain("private");
});
