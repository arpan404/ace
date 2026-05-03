import type {
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  GitHubCopilotModelOptions,
  ModelCapabilities,
  ModelSelection,
  ProviderKind,
  ServerProviderModel,
} from "@ace/contracts";
import {
  getDefaultContextWindow,
  getDefaultEffort,
  hasContextWindowOption,
  normalizeModelSlug,
  resolveEffort,
} from "@ace/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export interface MobileModelTraitState {
  readonly capabilities: ModelCapabilities;
  readonly effort: string | null;
  readonly defaultEffort: string | null;
  readonly thinking: boolean | null;
  readonly fastMode: boolean | null;
  readonly contextWindow: string | null;
  readonly defaultContextWindow: string | null;
  readonly contextLabel: "Context" | "Variant";
}

export type MobileModelTraitPatch =
  | { readonly kind: "effort"; readonly value: string }
  | { readonly kind: "thinking"; readonly value: boolean }
  | { readonly kind: "fastMode"; readonly value: boolean }
  | { readonly kind: "contextWindow"; readonly value: string };

export function getMobileProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

function getRawEffort(modelSelection: ModelSelection): string | null {
  switch (modelSelection.provider) {
    case "codex":
    case "githubCopilot":
    case "cursor":
      return modelSelection.options?.reasoningEffort ?? null;
    case "claudeAgent":
      return modelSelection.options?.effort ?? null;
    case "gemini":
    case "opencode":
      return null;
  }
}

function getRawContextWindow(modelSelection: ModelSelection): string | null {
  if (modelSelection.provider === "claudeAgent") {
    return modelSelection.options?.contextWindow ?? null;
  }
  if (modelSelection.provider === "opencode") {
    return modelSelection.options?.variant ?? null;
  }
  return null;
}

export function resolveMobileModelTraitState(
  modelSelection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel>,
): MobileModelTraitState {
  const capabilities = getMobileProviderModelCapabilities(
    models,
    modelSelection.model,
    modelSelection.provider,
  );
  const rawEffort = getRawEffort(modelSelection);
  const defaultEffort = getDefaultEffort(capabilities);
  const effort = resolveEffort(capabilities, rawEffort) ?? null;
  const defaultContextWindow = getDefaultContextWindow(capabilities);
  const rawContextWindow = getRawContextWindow(modelSelection);
  const contextWindow =
    rawContextWindow && hasContextWindowOption(capabilities, rawContextWindow)
      ? rawContextWindow
      : defaultContextWindow;

  return {
    capabilities,
    effort,
    defaultEffort,
    thinking:
      modelSelection.provider === "claudeAgent" && capabilities.supportsThinkingToggle
        ? (modelSelection.options?.thinking ?? true)
        : null,
    fastMode: capabilities.supportsFastMode
      ? ((modelSelection.options as { fastMode?: boolean } | undefined)?.fastMode ?? false)
      : null,
    contextWindow,
    defaultContextWindow,
    contextLabel: modelSelection.provider === "opencode" ? "Variant" : "Context",
  };
}

export function hasVisibleMobileModelTraits(state: MobileModelTraitState): boolean {
  return (
    state.capabilities.reasoningEffortLevels.length > 0 ||
    state.thinking !== null ||
    state.fastMode !== null ||
    state.capabilities.contextWindowOptions.length > 1
  );
}

export function applyMobileModelTraitPatch(
  modelSelection: ModelSelection,
  patch: MobileModelTraitPatch,
): ModelSelection {
  switch (modelSelection.provider) {
    case "codex": {
      if (patch.kind === "effort") {
        return {
          ...modelSelection,
          options: {
            ...modelSelection.options,
            reasoningEffort: patch.value as CodexModelOptions["reasoningEffort"],
          },
        };
      } else if (patch.kind === "fastMode") {
        return { ...modelSelection, options: { ...modelSelection.options, fastMode: patch.value } };
      }
      return modelSelection;
    }
    case "claudeAgent": {
      if (patch.kind === "effort") {
        return {
          ...modelSelection,
          options: {
            ...modelSelection.options,
            effort: patch.value as ClaudeModelOptions["effort"],
          },
        };
      } else if (patch.kind === "thinking") {
        return { ...modelSelection, options: { ...modelSelection.options, thinking: patch.value } };
      } else if (patch.kind === "fastMode") {
        return { ...modelSelection, options: { ...modelSelection.options, fastMode: patch.value } };
      } else if (patch.kind === "contextWindow") {
        return {
          ...modelSelection,
          options: { ...modelSelection.options, contextWindow: patch.value },
        };
      }
      return modelSelection;
    }
    case "githubCopilot": {
      if (patch.kind === "effort") {
        return {
          ...modelSelection,
          options: {
            ...modelSelection.options,
            reasoningEffort: patch.value as GitHubCopilotModelOptions["reasoningEffort"],
          },
        };
      }
      return modelSelection;
    }
    case "cursor": {
      if (patch.kind === "effort") {
        return {
          ...modelSelection,
          options: {
            ...modelSelection.options,
            reasoningEffort: patch.value as CursorModelOptions["reasoningEffort"],
          },
        };
      } else if (patch.kind === "fastMode") {
        return { ...modelSelection, options: { ...modelSelection.options, fastMode: patch.value } };
      }
      return modelSelection;
    }
    case "opencode": {
      if (patch.kind === "contextWindow") {
        return { ...modelSelection, options: { ...modelSelection.options, variant: patch.value } };
      } else if (patch.kind === "fastMode") {
        return { ...modelSelection, options: { ...modelSelection.options, fastMode: patch.value } };
      }
      return modelSelection;
    }
    case "gemini":
      return modelSelection;
  }
}
