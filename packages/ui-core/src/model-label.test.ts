import { expect, test } from "vitest";
import { modelLine, modelName } from "./model-label.ts";
import { modelLabel } from "./providers.ts";

test("model ids read the way the model pickers name them", () => {
  expect(modelLabel("opencode-go/muse-spark-1.3-contributor")).toBe("Muse Spark 1.3 Contributor");
  expect(
    modelName("opencode", "muse spark 1.3 contributor", "opencode-go/muse-spark-1.3-contributor"),
  ).toBe("Muse Spark 1.3 Contributor");
  expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelLabel("sonnet-4.6")).toBe("Sonnet 4.6");
  expect(modelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  expect(modelLabel("claude-opus-4-1")).toBe("Opus 4.1");
  expect(modelLabel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  expect(modelLabel("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
});

test("the provider's default reads the same whichever way it was reported", () => {
  // The catalog's own row, a thread with no model on record, and the id alone.
  for (const reported of ["Default (recommended)", undefined, "default", "claude:default"])
    expect(modelName("claude", reported)).toBe("Claude Code · Default");
  expect(modelName("codex")).toBe("Codex · Default");
});

test("a named model reads alone where its provider shows beside it", () => {
  expect(modelName("claude", "Opus 4.1")).toBe("Opus 4.1");
  expect(modelName("codex", "GPT-5 Codex (recommended)")).toBe("GPT-5 Codex");
});

test("where no provider shows beside it, the label names the provider first", () => {
  expect(modelLine("claude", "Opus 4.1")).toBe("Claude Code · Opus 4.1");
  expect(modelLine("claude", "Default (recommended)")).toBe("Claude Code · Default");
  // A name that already carries its provider isn't prefixed twice.
  expect(modelLine("claude", modelName("claude"))).toBe("Claude Code · Default");
  expect(modelLine("pi", undefined)).toBe("Pi · Default");
  expect(modelLine("claude", modelName("claude"), "work")).toBe("Claude Code · work · Default");
});
