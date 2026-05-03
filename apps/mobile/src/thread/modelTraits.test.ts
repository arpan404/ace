import { describe, expect, it } from "vitest";
import type { ModelSelection, ServerProviderModel } from "@ace/contracts";
import {
  applyMobileModelTraitPatch,
  hasVisibleMobileModelTraits,
  resolveMobileModelTraitState,
} from "./modelTraits";

const MODELS: ServerProviderModel[] = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "claude-opus",
    name: "Claude Opus",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [{ value: "max", label: "Max", isDefault: true }],
      supportsFastMode: true,
      supportsThinkingToggle: true,
      contextWindowOptions: [
        { value: "standard", label: "Standard", isDefault: true },
        { value: "large", label: "Large" },
      ],
      promptInjectedEffortLevels: [],
    },
  },
];

describe("mobile model traits", () => {
  it("resolves visible codex traits from model capabilities and defaults", () => {
    const selection: ModelSelection = { provider: "codex", model: "gpt-5.4" };
    const state = resolveMobileModelTraitState(selection, MODELS);

    expect(hasVisibleMobileModelTraits(state)).toBe(true);
    expect(state.effort).toBe("medium");
    expect(state.fastMode).toBe(false);
    expect(state.thinking).toBeNull();
  });

  it("applies provider-specific trait patches", () => {
    const selection: ModelSelection = { provider: "claudeAgent", model: "claude-opus" };

    expect(applyMobileModelTraitPatch(selection, { kind: "thinking", value: false })).toEqual({
      provider: "claudeAgent",
      model: "claude-opus",
      options: { thinking: false },
    });
    expect(
      applyMobileModelTraitPatch(selection, { kind: "contextWindow", value: "large" }),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-opus",
      options: { contextWindow: "large" },
    });
  });
});
