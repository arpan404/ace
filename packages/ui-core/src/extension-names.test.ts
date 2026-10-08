import { expect, test } from "vitest";
import { extensionDisplayName } from "./extension-names.ts";

test("authored human names preserve acronym casing and non-English words", () => {
  expect(extensionDisplayName("docs", "OpenAI SDK Guide")).toBe("OpenAI SDK Guide");
  expect(extensionDisplayName("resume", "résumé review")).toBe("Résumé Review");
  expect(extensionDisplayName("review", "déjà vu")).toBe("Déjà Vu");
});

test("qualified slugs become human names and plugin agents remain distinguishable", () => {
  expect(extensionDisplayName("engineering:code-review")).toBe("Code Review");
  expect(extensionDisplayName("reviewer")).toBe("Reviewer");
  expect(extensionDisplayName("engineering:reviewer", undefined, "engineering")).toBe(
    "Engineering Reviewer",
  );
});
