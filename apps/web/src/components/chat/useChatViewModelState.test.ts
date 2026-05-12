import { type ModelSelection, type ServerProvider } from "@ace/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import { describe, expect, it } from "vitest";

import { deriveChatViewProviderSelectionState } from "./useChatViewModelState";

function modelSelection(model: string, providerInstanceId?: string): ModelSelection {
  return {
    provider: "codex",
    ...(providerInstanceId ? { providerInstanceId } : {}),
    model,
  };
}

function codexProvider(input: {
  instanceId?: string;
  instanceLabel?: string;
  model: string;
}): ServerProvider {
  return {
    provider: "codex",
    ...(input.instanceId
      ? {
          providerInstanceId: input.instanceId,
          providerInstanceLabel: input.instanceLabel ?? input.instanceId,
          isDefaultProviderInstance: false,
        }
      : { isDefaultProviderInstance: true }),
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  };
}

describe("deriveChatViewProviderSelectionState", () => {
  it("treats a draft selection without providerInstanceId as an explicit default instance", () => {
    const state = deriveChatViewProviderSelectionState({
      draft: {
        activeProvider: "codex",
        modelSelectionByProvider: {
          codex: modelSelection("default-model"),
        },
      },
      hasThreadStarted: true,
      isServerThread: true,
      modelSettings: DEFAULT_UNIFIED_SETTINGS,
      projectModelSelection: null,
      providers: [
        codexProvider({ model: "default-model" }),
        codexProvider({
          instanceId: "personal",
          instanceLabel: "Personal",
          model: "personal-model",
        }),
      ],
      sessionProvider: "codex",
      threadModelSelection: modelSelection("personal-model", "personal"),
    });

    expect(state.selectedModelSelection).toEqual(modelSelection("default-model"));
    expect(state.selectedProviderModels.map((model) => model.slug)).toEqual(["default-model"]);
  });
});
