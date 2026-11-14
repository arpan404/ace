import { expect, test } from "vitest";
import { knownCliPath, type KnownCli } from "./utility-known-cli.ts";

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
  ["a signed-out account refuses the run", { auth: "logged_out" }, "unavailable"],
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
