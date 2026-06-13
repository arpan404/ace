import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type GitHubCopilotModelOptions,
  type OpenCodeModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
  type ProviderSessionConfigOption,
  type PiModelOptions,
  type ServerProviderModel,
} from "@ace/contracts";
import {
  getDefaultContextWindow,
  hasContextWindowOption,
  isClaudeUltrathinkPrompt,
  resolveEffort,
  trimOrNull,
} from "@ace/shared/model";

import { getProviderModelCapabilities } from "../../providerModels";
import { resolveCursorSelectorFamily } from "../../cursorModelSelector";

export type TraitsProviderOptions = ProviderModelOptions[ProviderKind];

export function getRawEffort(
  provider: ProviderKind,
  modelOptions: TraitsProviderOptions | null | undefined,
): string | null {
  switch (provider) {
    case "codex":
    case "githubCopilot":
    case "cursor":
      return trimOrNull(
        (
          modelOptions as
            | CodexModelOptions
            | GitHubCopilotModelOptions
            | CursorModelOptions
            | undefined
        )?.reasoningEffort,
      );
    case "claudeAgent":
      return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
    case "pi":
      return (
        trimOrNull((modelOptions as PiModelOptions | undefined)?.thoughtLevel) ??
        trimOrNull((modelOptions as PiModelOptions | undefined)?.reasoningEffort)
      );
    case "gemini":
    case "opencode":
      return null;
  }
}

function getRawContextWindow(
  provider: ProviderKind,
  modelOptions: TraitsProviderOptions | null | undefined,
): string | null {
  if (provider === "claudeAgent") {
    return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.contextWindow);
  }
  if (provider === "opencode") {
    return trimOrNull((modelOptions as OpenCodeModelOptions | undefined)?.variant);
  }
  return null;
}

export function findPiThoughtConfigOption(
  sessionConfigOptions: ReadonlyArray<ProviderSessionConfigOption> | undefined,
): ProviderSessionConfigOption | undefined {
  return (sessionConfigOptions ?? []).find(
    (option) => option.category === "thought_level" || option.id === "thought_level",
  );
}

export function getSelectedTraits(
  provider: ProviderKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: TraitsProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const effortLevels = allowPromptInjectedEffort
    ? caps.reasoningEffortLevels
    : caps.reasoningEffortLevels.filter(
        (option) => !caps.promptInjectedEffortLevels.includes(option.value),
      );

  const rawEffort = getRawEffort(provider, modelOptions);
  const effort = resolveEffort(caps, rawEffort) ?? null;

  const thinkingEnabled = caps.supportsThinkingToggle
    ? ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;

  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;

  const contextWindowOptions = caps.contextWindowOptions;
  const rawContextWindow = getRawContextWindow(provider, modelOptions);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const contextWindow =
    rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
      ? rawContextWindow
      : defaultContextWindow;

  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    caps.promptInjectedEffortLevels.length > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));

  return {
    caps,
    contextWindow,
    contextWindowOptions,
    defaultContextWindow,
    effort,
    effortLevels,
    fastModeEnabled,
    thinkingEnabled,
    ultrathinkInBodyText,
    ultrathinkPromptControlled,
  };
}

export function hasVisibleTraits(input: {
  effortLevels: ReadonlyArray<{ value: string }>;
  thinkingEnabled: boolean | null;
  supportsFastMode: boolean;
  contextWindowOptions: ReadonlyArray<{ value: string }>;
}): boolean {
  return (
    input.effortLevels.length > 0 ||
    input.thinkingEnabled !== null ||
    input.supportsFastMode ||
    input.contextWindowOptions.length > 1
  );
}

export function hasVisibleCursorTraits(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
): boolean {
  const family = resolveCursorSelectorFamily(models, model);
  if (!family) {
    return false;
  }
  return (
    family.reasoningEffortOptions.length > 0 ||
    family.supportsThinkingToggle ||
    family.supportsFastMode ||
    family.supportsMaxMode
  );
}

export function shouldRenderTraitsPicker(input: {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions?: TraitsProviderOptions | null | undefined;
  sessionConfigOptions?: ReadonlyArray<ProviderSessionConfigOption> | undefined;
  allowPromptInjectedEffort?: boolean;
}): boolean {
  if (input.provider === "cursor") {
    return hasVisibleCursorTraits(input.models, input.model);
  }
  if (input.provider === "pi") {
    const piThoughtOption = findPiThoughtConfigOption(input.sessionConfigOptions);
    if (piThoughtOption && piThoughtOption.options.length > 0) {
      return true;
    }
  }

  const { caps, contextWindowOptions, effortLevels, thinkingEnabled } = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
  );

  return hasVisibleTraits({
    contextWindowOptions,
    effortLevels,
    supportsFastMode: caps.supportsFastMode,
    thinkingEnabled,
  });
}
