import { expect, test } from "vitest";
import { extensionDisplayName } from "./extension-names.ts";

test("authored titles are kept as written, in sentence case", () => {
  expect(extensionDisplayName("docs", "OpenAI SDK Guide")).toBe("OpenAI SDK Guide");
  expect(extensionDisplayName("resume", "résumé review")).toBe("Résumé review");
  expect(extensionDisplayName("review", "déjà vu")).toBe("Déjà vu");
});

test("slugs read in sentence case with acronyms and product names spelled as people write them", () => {
  expect(extensionDisplayName("agents-sdk")).toBe("Agents SDK");
  expect(extensionDisplayName("setup-ts-deep-modules")).toBe("Setup TS deep modules");
  expect(extensionDisplayName("git-guardrails-claude-code")).toBe("Git guardrails Claude Code");
  expect(extensionDisplayName("ace-browser")).toBe("ace browser");
  expect(extensionDisplayName("setup-pre-commit")).toBe("Setup pre-commit");
  expect(extensionDisplayName("ios-release_notes")).toBe("iOS release notes");
});

test("qualified slugs drop their plugin and plugin agents stay distinguishable", () => {
  expect(extensionDisplayName("engineering:code-review")).toBe("Code review");
  expect(extensionDisplayName("reviewer")).toBe("Reviewer");
  expect(extensionDisplayName("engineering:reviewer", undefined, "engineering")).toBe(
    "Engineering reviewer",
  );
});
