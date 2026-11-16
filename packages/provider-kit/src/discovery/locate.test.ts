import { expect, test } from "vitest";
import { discoverProvider, locateProvider } from "./index.ts";

type Result = { stdout: string; stderr: string; code: number | null };

/** A CLI whose version answers at once and whose login status answers when told to. */
function slowLoginCli(version: string) {
  let answerLogin: ((result: Result) => void) | undefined;
  let failLogin: ((error: Error) => void) | undefined;
  const probe = (_command: string, args: readonly string[]) =>
    args[0] === "--version"
      ? Promise.resolve({ stdout: version, stderr: "", code: 0 })
      : new Promise<Result>((resolve, reject) => {
          answerLogin = resolve;
          failLogin = reject;
        });
  return {
    probe,
    login: (stdout: string) => answerLogin?.({ stdout, stderr: "", code: 0 }),
    loginFails: () => failLogin?.(new Error("boom")),
  };
}

// Any file that exists and is executable stands in for the CLI: probes are injected.
const options = (probe: ReturnType<typeof slowLoginCli>["probe"]) => ({
  overrides: { claude: process.execPath },
  probe,
});

test("a CLI is located with its version while its login probe is still running", async () => {
  const cli = slowLoginCli("2.1.286 (Claude Code)");
  const { located, discovered } = await locateProvider("claude", options(cli.probe));
  expect(located).toMatchObject({
    installed: true,
    path: process.execPath,
    version: "2.1.286",
    auth: "unknown",
  });
  cli.login(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
  expect(await discovered).toMatchObject({
    installed: true,
    path: process.execPath,
    version: "2.1.286",
    auth: "logged_in",
  });
});

test("the full result reads the same as a one-stage discovery", async () => {
  const staged = slowLoginCli("2.1.286 (Claude Code)");
  const stages = await locateProvider("claude", options(staged.probe));
  staged.login(JSON.stringify({ loggedIn: false }));
  const single = slowLoginCli("2.1.286 (Claude Code)");
  const whole = discoverProvider("claude", options(single.probe));
  // The one-stage read starts its login probe only once the CLI is found.
  await new Promise((resolve) => setTimeout(resolve, 10));
  single.login(JSON.stringify({ loggedIn: false }));
  expect(await stages.discovered).toEqual(await whole);
  expect((await whole).auth).toBe("logged_out");
});

test("a failed login probe is reported in the full result, the located one stays clean", async () => {
  const cli = slowLoginCli("2.1.286 (Claude Code)");
  const { located, discovered } = await locateProvider("claude", options(cli.probe));
  cli.loginFails();
  expect(located.error).toBeUndefined();
  expect(await discovered).toMatchObject({
    installed: true,
    auth: "unknown",
    error: "Authentication probe failed",
  });
});
