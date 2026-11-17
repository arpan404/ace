import { describe, expect, test } from "vitest";
import { cliOutputs } from "@ace/protocol/cli-outputs";
import type { ProviderStatus } from "@ace/protocol";
import { aceAccountLines, providerAccountLines } from "./account.ts";
import { modelIds, modelListLines } from "./model.ts";
import { providerListLines, providerShowLines, providerState } from "./provider.ts";

const base = {
  auth: "logged_in",
  loginHint: "",
  runtime: "cli",
  stale: false,
  refreshing: false,
} as const;
const status = (overrides: Partial<ProviderStatus>): ProviderStatus =>
  cliOutputs["provider.show"].parse({ provider: "codex", installed: true, ...base, ...overrides });

describe("provider list", () => {
  const golden = cliOutputs["provider.list"].parse({
    ok: true,
    providers: [
      { provider: "codex", installed: true, ...base, version: "0.130.0", accountLabel: "me@x.dev" },
      { provider: "claude", installed: true, ...base, auth: "logged_out" },
      { provider: "pi", installed: false, ...base, auth: "unknown", installCommand: "npm i -g pi" },
    ],
  });

  test("each provider reads as one aligned line with its state in words", () => {
    expect(providerListLines(golden)).toEqual([
      "codex   ready          0.130.0  me@x.dev",
      "claude  signed out",
      "pi      not installed",
    ]);
  });

  test("a signed-out provider names the login command; a missing one its install", () => {
    expect(providerShowLines(golden.providers[1] as ProviderStatus).at(-1)).toBe(
      "Sign in: ace provider login claude",
    );
    expect(providerShowLines(golden.providers[2] as ProviderStatus).at(-1)).toBe(
      "Install it: npm i -g pi",
    );
  });

  test.each([
    [{ enabled: false }, "off"],
    [{ versionCheck: { status: "too_old", installed: "1", required: "2" } }, "needs an update"],
    [{ auth: "unknown" }, "checking"],
    [{ error: "boom" }, "needs attention"],
  ] as const)("state %o reads as %s", (overrides, words) => {
    expect(providerState(status(overrides as Partial<ProviderStatus>)).words).toBe(words);
  });
});

const model = (id: string, provider: string, extra = {}) => ({
  id,
  displayName: id,
  provider,
  instance: `${provider}-cli-default`,
  nativeModelId: id,
  efforts: [],
  serviceTiers: [],
  inputModalities: ["text"],
  isDefault: false,
  hidden: false,
  deprecated: false,
  raw: { json: "{}", truncated: false },
  ...extra,
});

describe("model list", () => {
  const golden = cliOutputs["model.list"].parse({
    models: [
      model("gpt-6.1", "codex"),
      model("opus", "claude", { displayName: "Opus 5.5" }),
      model("old", "claude", { tier: "legacy" }),
    ],
    instances: [
      { provider: "claude", instance: "claude-cli-default", stale: true, refreshing: false },
    ],
  });

  test("models list by provider with ids first, and a stale catalogue says so", () => {
    expect(modelListLines(golden)).toEqual([
      "codex   gpt-6.1",
      "claude  opus     Opus 5.5",
      "claude  old                older",
      "",
      "claude-cli-default: models may be out of date.",
    ]);
  });

  test("--quiet prints the ids to pass as --model", () => {
    expect(modelIds(golden)).toEqual(["gpt-6.1", "opus", "old"]);
  });
});

describe("ace account", () => {
  test("signed in names the account and whether a machine code is set", () => {
    const value = cliOutputs["account.status"].parse({
      signedIn: true,
      account: { id: "a1", email: "me@x.dev", name: "Me" },
      machineCode: { set: false },
    });
    expect(aceAccountLines(value)).toEqual([
      "Signed in to ace as me@x.dev.",
      "No machine code. Set one with ace account machine-code set.",
    ]);
  });

  test("signed out points at ace login", () => {
    const value = cliOutputs["account.status"].parse({
      signedIn: false,
      machineCode: { set: false },
    });
    expect(aceAccountLines(value)).toEqual(["Not signed in to ace. Sign in with ace login."]);
  });
});

test("an empty provider account list says how to find accounts", () => {
  expect(providerAccountLines(cliOutputs["provider.account.list"].parse([]))).toEqual([
    "No provider accounts yet. Find them with ace provider account discover.",
  ]);
});
