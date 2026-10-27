import { expect, it } from "vitest";
import { codexToolListing } from "./tool-search.ts";

/** Slugs as Codex 0.163.0's bundled catalog lists them. */
const catalog = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"];

it("a catalog model keeps every ace tool listed, since Codex defers them behind its search", () => {
  expect(codexToolListing({ model: "gpt-6.1-sol", catalog })).toBe("all");
  // Codex matches the longest slug a model name starts with, so dated variants count too.
  expect(codexToolListing({ model: "gpt-5.5-2026-09-01", catalog })).toBe("all");
  // And once more after a single provider namespace.
  expect(codexToolListing({ model: "openrouter/gpt-5.6-sol", catalog })).toBe("all");
});

it("Codex's own default model is a catalog model", () => {
  expect(codexToolListing({ catalog })).toBe("all");
  expect(codexToolListing({})).toBe("all");
});

it("a model outside Codex's catalog gets the fixed list, since Codex would load every tool upfront", () => {
  expect(codexToolListing({ model: "gpt-oss:20b", provider: "ollama", catalog })).toBe("static");
  expect(codexToolListing({ model: "qwen3-coder", provider: "lmstudio", catalog })).toBe("static");
  // Only one simple namespace segment is stripped before matching.
  expect(codexToolListing({ model: "a/b/gpt-5.5", catalog })).toBe("static");
  expect(codexToolListing({ model: "my.gateway/gpt-5.5", catalog })).toBe("static");
});

it("Bedrock Runtime turns search off for every model, its default included", () => {
  expect(
    codexToolListing({
      model: "us.openai.gpt-6.1-sol",
      provider: "amazon-bedrock-runtime",
      catalog: ["us.openai.gpt-6.1-sol"],
    }),
  ).toBe("static");
  expect(codexToolListing({ provider: "amazon-bedrock-runtime" })).toBe("static");
  // Bedrock through Mantle uses Codex's own model metadata, which searches.
  expect(
    codexToolListing({
      model: "openai.gpt-6.1-sol",
      provider: "amazon-bedrock",
      catalog: ["openai.gpt-6.1-sol"],
    }),
  ).toBe("all");
});

it("strict third-party code mode keeps ace deferred without search, only on a code-mode-only turn", () => {
  const strict = { code_mode_only: true, code_mode_only_strict_3p_tools: true };
  expect(codexToolListing({ model: "gpt-oss:20b", catalog, features: strict })).toBe("all");
  expect(
    codexToolListing({
      model: "gpt-oss:20b",
      catalog,
      features: { code_mode_only_strict_3p_tools: true },
    }),
  ).toBe("static");
  // Bedrock Runtime's models are code-mode-only by their own metadata.
  expect(
    codexToolListing({
      provider: "amazon-bedrock-runtime",
      features: { code_mode_only_strict_3p_tools: true },
    }),
  ).toBe("all");
});

it("an unread catalog keeps every tool listed rather than guessing", () => {
  expect(codexToolListing({ model: "gpt-oss:20b", provider: "ollama" })).toBe("all");
});
