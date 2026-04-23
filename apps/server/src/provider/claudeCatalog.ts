import type { ModelCapabilities, ServerProviderModel } from "@ace/contracts";

type ClaudeSdkModelInfo = {
  readonly value: string;
  readonly displayName: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
};

const EMPTY_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const FALLBACK_CAPABILITIES_BY_MODEL: Record<string, ModelCapabilities> = {
  "claude-opus-4-6": {
    reasoningEffortLevels: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High", isDefault: true },
      { value: "max", label: "Max" },
      { value: "ultrathink", label: "Ultrathink" },
    ],
    supportsFastMode: true,
    supportsThinkingToggle: false,
    contextWindowOptions: [
      { value: "200k", label: "200k", isDefault: true },
      { value: "1m", label: "1M" },
    ],
    promptInjectedEffortLevels: ["ultrathink"],
  },
  "claude-sonnet-4-6": {
    reasoningEffortLevels: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High", isDefault: true },
      { value: "ultrathink", label: "Ultrathink" },
    ],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [
      { value: "200k", label: "200k", isDefault: true },
      { value: "1m", label: "1M" },
    ],
    promptInjectedEffortLevels: ["ultrathink"],
  },
  "claude-haiku-4-5": {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: true,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  },
};

const rememberedClaudeModels = new Map<string, ServerProviderModel>();

function toClaudeEffortLabel(value: string): string {
  switch (value) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return value
        .split(/[\s_-]+/g)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
        .join(" ");
  }
}

export function getClaudeFallbackModelCapabilities(
  model: string | null | undefined,
): ModelCapabilities {
  const slug = model?.trim();
  return (slug && FALLBACK_CAPABILITIES_BY_MODEL[slug]) || EMPTY_CLAUDE_MODEL_CAPABILITIES;
}

export function rememberClaudeModels(models: ReadonlyArray<ServerProviderModel>): void {
  rememberedClaudeModels.clear();
  for (const model of models) {
    rememberedClaudeModels.set(model.slug, model);
  }
}

export function getRememberedClaudeModelCapabilities(
  model: string | null | undefined,
): ModelCapabilities | null {
  const slug = model?.trim();
  if (!slug) {
    return null;
  }
  return rememberedClaudeModels.get(slug)?.capabilities ?? null;
}

export function toClaudeServerProviderModel(model: ClaudeSdkModelInfo): ServerProviderModel {
  const fallbackCapabilities = getClaudeFallbackModelCapabilities(model.value);
  const reasoningEffortLevels =
    model.supportsEffort && model.supportedEffortLevels && model.supportedEffortLevels.length > 0
      ? model.supportedEffortLevels.map((value) => ({
          value,
          label: toClaudeEffortLabel(value),
          ...(value === "high" ? { isDefault: true } : {}),
        }))
      : fallbackCapabilities.reasoningEffortLevels;

  return {
    slug: model.value,
    name: model.displayName.trim().length > 0 ? model.displayName : model.value,
    isCustom: false,
    capabilities: {
      reasoningEffortLevels,
      supportsFastMode: model.supportsFastMode ?? fallbackCapabilities.supportsFastMode,
      supportsThinkingToggle:
        model.supportsAdaptiveThinking ?? fallbackCapabilities.supportsThinkingToggle,
      contextWindowOptions: fallbackCapabilities.contextWindowOptions,
      promptInjectedEffortLevels: fallbackCapabilities.promptInjectedEffortLevels,
    },
  };
}
