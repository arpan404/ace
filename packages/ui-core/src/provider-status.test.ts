import { ProviderKind } from "@ace/protocol";
import { AccountSummary } from "@ace/protocol/accounts";
import { expect, test } from "vitest";
import { accountView } from "./accounts.ts";
import {
  providerChoiceLabel,
  providerStatuses,
  startingProvider,
  type ProviderState,
} from "./provider-status.ts";

const account = (id: string, provider: ProviderKind, signedIn = true) =>
  accountView(
    AccountSummary.parse({
      id,
      provider,
      label: id,
      installationVersion: "0.48",
      availability: signedIn ? "available" : "logged_out",
      quota: {
        auth: signedIn ? "logged_in" : "logged_out",
        observedAt: 0,
        windows: {},
        usage: {},
      },
    }),
  );

const statuses = (entries: Partial<Record<ProviderKind, ProviderState>>) =>
  Object.entries(entries).map(([provider, state]) => ({
    provider: ProviderKind.parse(provider),
    state: state ?? "not_installed",
  }));

test("an installed CLI with no authentication evidence stays unknown", () => {
  const listed = providerStatuses(new Set(["codex"]), []);
  const codex = listed.find((status) => status.provider === "codex");

  expect(codex?.state).toBe("unknown");
  expect(codex && providerChoiceLabel(codex)).toBe("Codex (sign-in unknown)");
});

test("an installed Pi is offered like the other native CLIs", () => {
  const pi = providerStatuses(new Set(["pi"]), []).find((status) => status.provider === "pi");

  expect(pi && providerChoiceLabel(pi)).toBe("Pi (sign-in unknown)");
  expect(pi?.state).toBe("unknown");
});

test("a CLI whose ace accounts are all signed out reads not signed in", () => {
  const listed = providerStatuses(new Set(["claude", "codex"]), [
    account("claude-work", "claude", false),
    account("codex-personal", "codex", false),
    account("codex-team", "codex"),
  ]);

  expect(listed.slice(0, 2).map(providerChoiceLabel)).toEqual([
    "Claude Code (not signed in)",
    "Codex",
  ]);
});

test("an account left behind by an uninstalled CLI doesn't make it installed", () => {
  const listed = providerStatuses(new Set(), [account("claude-work", "claude")]);

  expect(listed.map(providerChoiceLabel).slice(0, 2)).toEqual([
    "Claude Code (not installed)",
    "Codex (not installed)",
  ]);
});

test("the Settings default wins over the last-used provider", () => {
  const providers = statuses({ claude: "ready", codex: "ready", opencode: "ready" });

  expect(startingProvider({ chosen: "opencode", lastUsed: "codex", providers })).toBe("opencode");
});

test("with no Settings default, a new thread starts on the last-used provider", () => {
  const providers = statuses({ claude: "ready", codex: "ready" });

  expect(startingProvider({ chosen: undefined, lastUsed: "codex", providers })).toBe("codex");
});

test("with nothing chosen or used, the first ready provider in discovery order starts", () => {
  const providers = statuses({ claude: "not_installed", codex: "signed_out", cursor: "ready" });

  expect(startingProvider({ chosen: undefined, lastUsed: undefined, providers })).toBe("cursor");
});

test("a chosen or last-used provider that can't run is passed over, never Claude Code by default", () => {
  const providers = statuses({ claude: "not_installed", codex: "ready", opencode: "signed_out" });

  expect(startingProvider({ chosen: "claude", lastUsed: "opencode", providers })).toBe("codex");
});

test("with no ready provider, an installed but signed-out one starts so the composer can say so", () => {
  const providers = statuses({ claude: "not_installed", codex: "signed_out" });

  expect(startingProvider({ chosen: undefined, lastUsed: undefined, providers })).toBe("codex");
  expect(
    startingProvider({ chosen: "claude", lastUsed: "claude", providers: statuses({}) }),
  ).toBeUndefined();
});

test("Cursor appears once with SDK setup action and the retired CLI account is hidden", () => {
  const listed = providerStatuses(
    new Set(["cursor"]),
    [account("cursor-cli-default", "cursor"), account("cursor-sdk-default", "cursor", false)],
    [
      {
        provider: "cursor",
        runtime: "cli",
        stale: false,
        refreshing: false,
        installed: true,
        auth: "logged_in",
        loginHint: "legacy",
      },
      {
        provider: "cursor",
        runtime: "cursor-sdk",
        stale: false,
        refreshing: false,
        installed: true,
        auth: "logged_out",
        loginHint: "Sign in to Cursor",
        state: "not_configured",
        actionId: "provider.sign_in",
      },
    ],
  ).filter((row) => row.provider === "cursor");
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    name: "Cursor",
    state: "signed_out",
    binary: "@cursor/sdk",
    actionId: "provider.sign_in",
  });
  expect(listed[0]?.accounts.map((row) => row.id)).toEqual(["cursor-sdk-default"]);
});
