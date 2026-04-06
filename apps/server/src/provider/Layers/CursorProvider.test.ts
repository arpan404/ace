import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { parseCursorModelsOutput, resolveCursorCliModelId } from "./CursorProvider.ts";

const CODEX_MAX_MODELS_OUTPUT = `
gpt-5.1-codex-max-low - GPT-5.1 Codex Max Low
gpt-5.1-codex-max - GPT-5.1 Codex Max
gpt-5.1-codex-max-high-fast - GPT-5.1 Codex Max High Fast
gpt-5.1-codex-max-xhigh - GPT-5.1 Codex Max Extra High
`;

const HIGH_ONLY_MODELS_OUTPUT = `
gpt-5.3-codex-high - GPT-5.3 Codex High
gpt-5.3-codex-xhigh - GPT-5.3 Codex Extra High
`;

describe("CursorProvider", () => {
  it("keeps Codex Max variants grouped under the Codex Max family", () => {
    const models = parseCursorModelsOutput(CODEX_MAX_MODELS_OUTPUT);

    assert.deepEqual(
      models.map((model) => ({
        slug: model.slug,
        familySlug: model.cursorMetadata?.familySlug,
        familyName: model.cursorMetadata?.familyName,
        reasoningEffort: model.cursorMetadata?.reasoningEffort,
        fastMode: model.cursorMetadata?.fastMode,
        maxMode: model.cursorMetadata?.maxMode,
      })),
      [
        {
          slug: "gpt-5.1-codex-max-low",
          familySlug: "gpt-5.1-codex-max",
          familyName: "GPT-5.1 Codex Max",
          reasoningEffort: "low",
          fastMode: false,
          maxMode: false,
        },
        {
          slug: "gpt-5.1-codex-max",
          familySlug: "gpt-5.1-codex-max",
          familyName: "GPT-5.1 Codex Max",
          reasoningEffort: undefined,
          fastMode: false,
          maxMode: false,
        },
        {
          slug: "gpt-5.1-codex-max-high-fast",
          familySlug: "gpt-5.1-codex-max",
          familyName: "GPT-5.1 Codex Max",
          reasoningEffort: "high",
          fastMode: true,
          maxMode: false,
        },
        {
          slug: "gpt-5.1-codex-max-xhigh",
          familySlug: "gpt-5.1-codex-max",
          familyName: "GPT-5.1 Codex Max",
          reasoningEffort: "xhigh",
          fastMode: false,
          maxMode: false,
        },
      ],
    );

    assert.deepEqual(models[0]?.capabilities, {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High", isDefault: false },
        { value: "high", label: "High", isDefault: false },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "low", label: "Low", isDefault: false },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    });

    assert.equal(
      resolveCursorCliModelId({
        model: "gpt-5.1-codex-max",
        options: { reasoningEffort: "high", fastMode: true },
      }),
      "gpt-5.1-codex-max-high-fast",
    );
  });

  it("marks the lowest discovered Cursor effort as the default when no base variant exists", () => {
    const models = parseCursorModelsOutput(HIGH_ONLY_MODELS_OUTPUT);

    assert.deepEqual(models[0]?.capabilities?.reasoningEffortLevels, [
      { value: "xhigh", label: "Extra High", isDefault: false },
      { value: "high", label: "High", isDefault: true },
    ]);
  });
});
