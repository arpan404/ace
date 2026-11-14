import { describe, expect, it } from "vitest";
import { spellcheckLanguages } from "./spellcheck.ts";

const available = ["de-DE", "en-AU", "en-GB", "en-US", "fr", "pt-BR"];

describe("the spellchecker's language", () => {
  it("is the person's first system language Chromium has a dictionary for, only that one", () => {
    expect(spellcheckLanguages(["ne-NP", "en-GB", "de-DE"], available)).toEqual(["en-GB"]);
  });

  it("falls back from a regional locale to a dictionary for the same language", () => {
    expect(spellcheckLanguages(["fr-CA"], available)).toEqual(["fr"]);
    expect(spellcheckLanguages(["pt-PT"], available)).toEqual(["pt-BR"]);
  });

  it("is US English when no system language has a dictionary", () => {
    expect(spellcheckLanguages(["ne-NP"], available)).toEqual(["en-US"]);
    expect(spellcheckLanguages([], available)).toEqual(["en-US"]);
  });
});
