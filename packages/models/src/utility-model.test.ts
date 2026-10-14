import { expect, test } from "vitest";
import { CatalogModel, ProviderStatus, type ProviderKind } from "@ace/protocol";
import { readyProviders, resolveUtilityModel } from "./utility-model.ts";

const ready = (provider: ProviderKind, readiness: ProviderStatus["readiness"] = "signed_in") =>
  ProviderStatus.parse({
    provider,
    runtime: "cli",
    installed: true,
    auth: "logged_in",
    loginHint: "",
    readiness,
    stale: false,
    refreshing: false,
  });
const model = (provider: ProviderKind, id: string, extra: Partial<CatalogModel> = {}) =>
  CatalogModel.parse({
    id,
    displayName: id,
    provider,
    instance: `${provider}-cli-default`,
    nativeModelId: id,
    reasoningEfforts: [],
    serviceTiers: [],
    inputModalities: ["text"],
    isDefault: false,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
    ...extra,
  });
const catalog = [
  model("codex", "gpt-6.1-sol", { reasoningEfforts: ["low", "medium", "high"], isDefault: true }),
  model("codex", "gpt-6-luna", { reasoningEfforts: ["medium", "minimal", "high"] }),
  model("claude", "claude-opus-5-5", { isDefault: true }),
  model("claude", "claude-haiku-4-5", { reasoningEfforts: ["high", "low"] }),
  model("opencode", "anthropic/claude-sonnet-5-2"),
  model("opencode", "opencode/big-pickle", { free: true }),
];

test("with Codex ready the default is gpt-6-luna at its lowest effort", () => {
  expect(
    resolveUtilityModel({
      choice: null,
      ready: readyProviders([ready("claude"), ready("codex")]),
      models: catalog,
    }),
  ).toMatchObject({ provider: "codex", model: "gpt-6-luna", effort: "minimal", chosen: false });
});

test("with only Claude ready the default is its Haiku", () => {
  expect(
    resolveUtilityModel({
      choice: null,
      ready: readyProviders([ready("claude"), ready("codex", "installed_signed_out")]),
      models: catalog,
    }),
  ).toMatchObject({ provider: "claude", model: "claude-haiku-4-5", effort: "low" });
});

test("a provider whose account lacks its default model steps to the next provider", () => {
  const withoutLuna = catalog.filter((row) => row.id !== "gpt-6-luna");
  expect(
    resolveUtilityModel({
      choice: null,
      ready: readyProviders([ready("codex"), ready("claude")]),
      models: withoutLuna,
    }),
  ).toMatchObject({ provider: "claude", model: "claude-haiku-4-5" });
  expect(
    resolveUtilityModel({
      choice: null,
      ready: readyProviders([ready("codex"), ready("claude"), ready("opencode")]),
      models: withoutLuna.filter((row) => row.provider !== "claude"),
    }),
  ).toMatchObject({ provider: "opencode", model: "opencode/big-pickle" });
});

test("a disabled provider is skipped, and with none ready there is no utility model", () => {
  const codex = { ...ready("codex"), enabled: false };
  expect(
    resolveUtilityModel({
      choice: null,
      ready: readyProviders([codex, ready("claude")]),
      models: catalog,
    }),
  ).toMatchObject({ provider: "claude" });
  expect(
    resolveUtilityModel({ choice: null, ready: readyProviders([codex]), models: catalog }),
  ).toBeUndefined();
});

test("the person's choice overrides the default, and falls back once its provider isn't ready", () => {
  const choice = { provider: "claude" as const, model: "claude-opus-5-5" };
  expect(
    resolveUtilityModel({
      choice,
      ready: readyProviders([ready("codex"), ready("claude")]),
      models: catalog,
    }),
  ).toMatchObject({ provider: "claude", model: "claude-opus-5-5", chosen: true });
  expect(
    resolveUtilityModel({
      choice,
      ready: readyProviders([ready("codex"), ready("claude", "installed_signed_out")]),
      models: catalog,
    }),
  ).toMatchObject({ provider: "codex", model: "gpt-6-luna", chosen: false });
});
