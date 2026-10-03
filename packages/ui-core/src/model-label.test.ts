import { expect, test } from "vitest";
import { modelLabel } from "./providers.ts";

test("model ids read the way the model pickers name them", () => {
  expect(modelLabel("sonnet-4.6")).toBe("Sonnet 4.6");
  expect(modelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  expect(modelLabel("claude-opus-4-1")).toBe("Opus 4.1");
  expect(modelLabel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  expect(modelLabel("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
});
