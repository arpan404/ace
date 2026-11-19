import type { SourceControlReadiness } from "@ace/protocol";
import { expect, test } from "vitest";
import { hostFacts } from "./source-control-status.tsx";

const ready = {
  cli: "available",
  version: "2.76.0",
  api: "ready",
  account: "ada",
  accounts: [{ login: "ada", active: true }],
  preferences: { host: "github.com", hosts: [{ host: "github.com" }], remote: "origin" },
} as unknown as SourceControlReadiness;

test.each([
  ["a signed-in GitHub CLI", ready, "github", ["Signed in as ada", "gh 2.76.0"]],
  [
    "a CLI with other accounts names them, marking the active one",
    {
      ...ready,
      account: "ada",
      accounts: [
        { login: "ada", active: false },
        { login: "octo", active: true },
      ],
    },
    "github",
    ["Signed in as ada", "gh 2.76.0", "Other CLI accounts: octo (active)"],
  ],
  [
    "a missing CLI says so once",
    {
      ...ready,
      cli: "unavailable",
      version: null,
      api: "unavailable",
      account: null,
      accounts: [],
    },
    "github",
    ["CLI not installed"],
  ],
  [
    "a missing CLI is named beside a sign-in problem",
    {
      ...ready,
      cli: "unavailable",
      version: null,
      api: "login_required",
      account: null,
      accounts: [],
    },
    "github",
    ["Not signed in", "CLI not installed"],
  ],
  ["a provider ace can't read yet", ready, "gitbucket", ["API support pending"]],
] as const)("%s", (_, status, forge, facts) => {
  expect(hostFacts(status as SourceControlReadiness, forge)).toEqual(facts);
});
