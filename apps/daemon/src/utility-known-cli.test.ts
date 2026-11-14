import { expect, test } from "vitest";
import {
  knownCliPath,
  locateKnownCli,
  type DiscoverCli,
  type KnownCli,
} from "./utility-known-cli.ts";

const installed = { runtime: "cli" as const, installed: true, path: "/opt/bin/codex" };
const known = (overrides: Partial<KnownCli>): KnownCli => ({
  status: installed,
  binary: undefined,
  auth: "logged_in",
  needsLogin: true,
  ...overrides,
});

test.each<[string, Partial<KnownCli>, string]>([
  ["a checked, signed-in CLI runs at its checked path", {}, "/opt/bin/codex"],
  ["a login not yet observed still runs", { auth: "unknown" }, "/opt/bin/codex"],
  ["a login last seen signed out asks the CLI again", { auth: "logged_out" }, "probe"],
  ["a signed-out OpenCode still runs", { auth: "logged_out", needsLogin: false }, "/opt/bin/codex"],
  [
    "a CLI the check found missing refuses the run",
    { status: { ...installed, installed: false } },
    "unavailable",
  ],
  ["no check yet asks the CLI", { status: undefined }, "probe"],
  [
    "a selection not checked yet asks the CLI",
    { status: { ...installed, installed: null } },
    "probe",
  ],
  ["a binary other than the checked one asks the CLI", { binary: "/custom/codex" }, "probe"],
  ["the checked binary itself runs", { binary: "/opt/bin/codex" }, "/opt/bin/codex"],
  [
    "an SDK row says nothing about the CLI",
    { status: { ...installed, runtime: "cursor-sdk" } },
    "probe",
  ],
])("%s", (_name, overrides, expected) => {
  expect(knownCliPath(known(overrides))).toBe(expected);
});

/** A CLI that answers as `answer` says, recording which binary each probe asked. */
function cli(answer: Awaited<ReturnType<DiscoverCli>>) {
  const asked: (string | undefined)[] = [];
  const discover: DiscoverCli = async (binary) => {
    asked.push(binary);
    return answer;
  };
  return { discover, asked };
}

test("a person who signed in through the CLI after ace saw a logout gets titles again", async () => {
  const signedIn = cli({ installed: true, path: "/opt/bin/codex", auth: "logged_in" });
  expect(await locateKnownCli(known({ auth: "logged_out" }), signedIn.discover)).toBe(
    "/opt/bin/codex",
  );
  expect(signedIn.asked).toEqual([undefined]);
});

test("a login that is still signed out refuses the run after asking the CLI", async () => {
  const signedOut = cli({ installed: true, path: "/opt/bin/codex", auth: "logged_out" });
  expect(await locateKnownCli(known({ auth: "logged_out" }), signedOut.discover)).toBeUndefined();
  expect(signedOut.asked).toHaveLength(1);
});

test("an account's own binary is asked about, even with a stale logout", async () => {
  const custom = cli({ installed: true, path: "/custom/codex", auth: "logged_in" });
  const path = await locateKnownCli(
    known({ binary: "/custom/codex", auth: "logged_out" }),
    custom.discover,
  );
  expect(path).toBe("/custom/codex");
  expect(custom.asked).toEqual(["/custom/codex"]);
});

test("a known, signed-in CLI runs without asking it anything", async () => {
  const unused = cli({ installed: false, auth: "unknown" });
  expect(await locateKnownCli(known({}), unused.discover)).toBe("/opt/bin/codex");
  expect(unused.asked).toEqual([]);
});
