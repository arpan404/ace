import { expect, test } from "vitest";
import { CatalogModel, type ProviderKind } from "@ace/protocol";
import { resolveModelName, searchModels } from "./index.ts";

function row(
  provider: ProviderKind,
  id: string,
  displayName: string,
  extra: Partial<CatalogModel> = {},
): CatalogModel {
  return CatalogModel.parse({
    id,
    nativeModelId: id,
    displayName,
    provider,
    instance: `${provider}-cli-default`,
    efforts: [],
    serviceTiers: [],
    inputModalities: [],
    isDefault: false,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
    ...extra,
  });
}

// Newest first within a family, as the catalog orders them.
const catalog = [
  row("claude", "claude-opus-5-5", "Opus 5.5", { family: "claude-opus", tier: "current" }),
  row("claude", "claude-sonnet-5-5", "Sonnet 5.5", { family: "claude-sonnet", tier: "current" }),
  row("claude", "claude-opus-5", "Opus 5", { family: "claude-opus", tier: "legacy" }),
  row("claude", "claude-opus-4-8", "Opus 4.8", { family: "claude-opus", tier: "legacy" }),
  row("claude", "claude-opus-4-7", "Opus 4.7", { family: "claude-opus", tier: "legacy" }),
  row("codex", "gpt-6.1-sol", "GPT-6.1 Sol"),
  row("codex", "gpt-6-luna", "GPT-6 Luna"),
  row("codex", "gpt-6-astra", "GPT-6 Astra"),
  row("pi", "openai-codex/gpt-6.1-sol", "GPT-6.1 Sol"),
  row("opencode", "opencode-go/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"),
  row("opencode", "opencode/muse-spark-1.3", "Muse Spark 1.3"),
];
const chosen = (name: string) => {
  const found = resolveModelName(catalog, name);
  return found.kind === "match" ? found.model.id : found.kind;
};

test("a family name without a version means the newest current model of that family", () => {
  expect(chosen("opus")).toBe("claude-opus-5-5");
  expect(chosen("Sonnet")).toBe("claude-sonnet-5-5");
});

test("a written version picks that version, not a longer one that contains it", () => {
  expect(chosen("opus 5.5")).toBe("claude-opus-5-5");
  expect(chosen("Opus 5")).toBe("claude-opus-5");
  expect(chosen("opus 4")).toBe("claude-opus-4-8");
});

test("a version is read in order and from its start, never as loose numbers", () => {
  const older = [row("claude", "claude-opus-4-5", "Opus 4.5", { family: "claude-opus" })];
  expect(resolveModelName(older, "opus 5.4").kind).toBe("none");
  expect(resolveModelName(older, "opus 5").kind).toBe("none");
  expect(chosen("opus 8")).toBe("none");
  expect(chosen("opus 4.8")).toBe("claude-opus-4-8");
});

test("spacing, case and punctuation do not matter", () => {
  expect(chosen("gpt 6.1 sol")).toBe("gpt-6.1-sol");
  expect(chosen("GPT6.1-Sol")).toBe("gpt-6.1-sol");
});

test("the maker's own model ranks before the same model through a gateway", () => {
  expect(resolveModelName(catalog, "gpt 6.1 sol")).toMatchObject({
    kind: "match",
    model: { provider: "codex" },
  });
});

test("the plainest name wins over variants with extra words", () => {
  expect(chosen("muse spark")).toBe("opencode/muse-spark-1.3");
  expect(chosen("muse spark contributor")).toBe("opencode-go/muse-spark-1.3-contributor");
});

test("a word may be the start of a longer one", () => {
  expect(chosen("sonn 5.5")).toBe("claude-sonnet-5-5");
});

test("a name that fits different models equally is ambiguous, with every option named", () => {
  const found = resolveModelName(catalog, "gpt 6");
  expect(found.kind).toBe("ambiguous");
  expect(found.kind === "ambiguous" && found.options.map((model) => model.id).toSorted()).toEqual([
    "gpt-6-astra",
    "gpt-6-luna",
  ]);
});

test("a name no model fits finds nothing", () => {
  expect(chosen("gemini")).toBe("none");
  expect(chosen("opus 9")).toBe("none");
  expect(searchModels(catalog, "  -- ")).toEqual([]);
});

test("search lists the nearest models first, one row per account", () => {
  const second = row("codex", "gpt-6.1-sol", "GPT-6.1 Sol", { instance: "account-346" });
  const found = searchModels([...catalog, second], "sol").map((model) => model.instance);
  expect(found.slice(0, 2).toSorted()).toEqual(["account-346", "codex-cli-default"]);
  expect(found.at(-1)).toBe("pi-cli-default");
});

test("the same model through two upstream routes is ambiguous, never a silent pick", () => {
  const routes = [
    row("opencode", "openai/gpt-6.1-sol", "GPT-6.1 Sol", {
      family: "gpt-6.1",
      nativeProviderId: "openai",
    }),
    row("opencode", "azure/gpt-6.1-sol", "GPT-6.1 Sol", {
      family: "gpt-6.1",
      nativeProviderId: "azure",
    }),
  ];
  const found = resolveModelName(routes, "gpt 6.1 sol");
  expect(found.kind).toBe("ambiguous");
  expect(found.kind === "ambiguous" && found.options.map((model) => model.id).toSorted()).toEqual([
    "azure/gpt-6.1-sol",
    "openai/gpt-6.1-sol",
  ]);
  // One route still resolves a family name to its newest version.
  expect(resolveModelName([routes[0] as CatalogModel], "gpt 6.1 sol").kind).toBe("match");
});
