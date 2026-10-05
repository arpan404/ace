import { expect, test } from "vitest";
import { runCursorAccountFlow } from "./cursor-account-flow.ts";

test.each(["login", "logout"])(
  "SDK terminal uses its own %s and prints no returned authentication data",
  async (action) => {
    const operations: string[] = [];
    let output = "";
    let error = "";
    const result = await runCursorAccountFlow(
      ["account-fixture", "/temporary/daemon/account-homes/account-fixture", action],
      {
        signal: new AbortController().signal,
        output: (text) => {
          output += text;
        },
        error: (text) => {
          error += text;
        },
        driver: {
          login: async (instance, _signal, url) => {
            operations.push(`login:${instance.homeDir}`);
            url("https://fixture.invalid/login");
            return { status: "logged-in", source: "sdk-store", key: "fixture-private-return" };
          },
          logout: async (instance) => {
            operations.push(`logout:${instance.homeDir}`);
            return { status: "logged-out", source: "none", key: "fixture-private-return" };
          },
        },
      },
    );
    expect(result).toBe(0);
    expect(operations).toEqual([`${action}:/temporary/daemon/account-homes/account-fixture`]);
    expect(output).toBe(
      `${action === "login" ? "https://fixture.invalid/login\r\n" : ""}Cursor SDK authentication flow completed.\r\n`,
    );
    expect(output + error).not.toContain("fixture-private-return");
    expect(error).toBe("");
  },
);

test("SDK failures print only a generic terminal error", async () => {
  let output = "";
  expect(
    await runCursorAccountFlow(
      ["account-fixture", "/temporary/daemon/account-homes/account-fixture", "login"],
      {
        signal: new AbortController().signal,
        output: (text) => {
          output += text;
        },
        error: (text) => {
          output += text;
        },
        driver: {
          login: async () => {
            throw new Error("fixture-private-return");
          },
          logout: async () => {
            throw new Error("Must not log out");
          },
        },
      },
    ),
  ).toBe(1);
  expect(output).toBe("Cursor SDK authentication flow failed.\r\n");
});
