import { expect, test } from "vitest";
import { CatalogModel } from "@ace/protocol";
import { configuredModels, resolveModel, normalizeClaude } from "./index.ts";
import { instance } from "./testing/support.ts";

function rows(ids: string[], provider: CatalogModel["provider"] = "codex") {
  return ids.map((id) =>
    CatalogModel.parse({
      id,
      nativeModelId: id,
      displayName: id,
      provider,
      instance: "account",
      isDefault: false,
      hidden: false,
      deprecated: false,
      reasoningEfforts: [],
      serviceTiers: [],
      inputModalities: ["text"],
      raw: { json: "{}", truncated: false },
    }),
  );
}
test("each family keeps its newest version current while older routes remain selectable", () => {
  const view = configuredModels(
    rows(["gpt-6", "gpt-5.5", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna"]),
    "codex",
    "account",
    { provider: "codex", favourites: ["gpt-5.6-sol"] },
  );
  expect(view.filter((row) => row.tier === "current").map((row) => row.id)).toEqual([
    "gpt-6.1-sol",
    "gpt-6",
    "gpt-6-luna",
  ]);
  expect(view.filter((row) => row.tier === "legacy").map((row) => row.id)).toEqual([
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.5",
  ]);
  expect(view.find((row) => row.id === "gpt-5.6-sol")).toMatchObject({
    favourite: true,
    hidden: false,
  });
  expect(resolveModel({ role: "thread", model: "gpt-5.6-sol" }, view, () => false)).toMatchObject({
    ok: true,
    model: { id: "gpt-5.6-sol", tier: "legacy" },
  });
  expect(
    view.toSorted((a, b) => (a.sortKey ?? "").localeCompare(b.sortKey ?? "")).map((row) => row.id),
  ).toEqual(view.map((row) => row.id));
});
test("numeric flagship defaults advance without a hard-coded model id and migrate the default sentinel", () => {
  const native = normalizeClaude(
    {
      models: [
        "default",
        "claude-opus-5-5",
        "claude-opus-6-1",
        "claude-opus-6-2",
        "claude-sonnet-7",
        "claude-haiku-4-5-20251001",
      ].map((value) => ({ value, displayName: value, isDefault: value === "default" })),
    },
    instance("claude", "account"),
  );
  const view = configuredModels(native, "claude", "account", {
    provider: "claude",
    defaultModel: "default",
  });
  expect(view.find((row) => row.isDefault)?.id).toBe("claude-opus-6-2");
  expect(view.some((row) => row.id === "default")).toBe(false);
  expect(resolveModel({ role: "thread", model: "default" }, view, () => false)).toMatchObject({
    ok: true,
    model: { id: "claude-opus-6-2" },
  });
});
test("settings may make a pinned legacy model the concrete default", () => {
  const view = configuredModels(rows(["gpt-6.1-sol", "gpt-5.6-sol"]), "codex", "account", {
    provider: "codex",
    defaultModel: "gpt-5.6-sol",
  });
  expect(resolveModel({ role: "thread" }, view, () => false)).toMatchObject({
    ok: true,
    model: { id: "gpt-5.6-sol", defaultSource: "user", tier: "legacy" },
  });
});
test("provider deprecation beats lifecycle exceptions and known exceptions can retire a unique tier", () => {
  const view = configuredModels(rows(["gpt-5-codex-mini"]), "codex", "account", {
    provider: "codex",
  });
  expect(view[0]?.tier).toBe("legacy");
  const cursor = configuredModels(
    rows(["auto"], "cursor").map((row) => Object.assign({}, row, { deprecated: true })),
    "cursor",
    "account",
    { provider: "cursor" },
  );
  expect(cursor[0]).toMatchObject({ tier: "legacy", isDefault: false });
});
test("accounts and upstream providers classify their own available versions", () => {
  const view = configuredModels(
    rows(["anthropic/claude-opus-5-5", "router/claude-opus-4-8"], "opencode").map((row) =>
      Object.assign({}, row, {
        nativeProviderId: row.id.split("/")[0],
      }),
    ),
    "opencode",
    "account",
    { provider: "opencode" },
  );
  expect(view.every((row) => row.tier === "current")).toBe(true);
});
