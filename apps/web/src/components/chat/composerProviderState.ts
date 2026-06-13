import {
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
} from "@ace/contracts";
import {
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
  normalizeGitHubCopilotModelOptionsWithCapabilities,
  normalizeOpenCodeModelOptionsWithCapabilities,
  normalizePiModelOptionsWithCapabilities,
  resolveEffort,
} from "@ace/shared/model";
import { getProviderModelCapabilities } from "../../providerModels";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

function getProviderStateFromCapabilities(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const { provider, model, models, prompt, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const providerOptions = modelOptions?.[provider];

  const rawEffort =
    provider === "claudeAgent"
      ? providerOptions && "effort" in providerOptions
        ? providerOptions.effort
        : null
      : provider === "pi"
        ? providerOptions && typeof providerOptions === "object"
          ? "thoughtLevel" in providerOptions &&
            typeof providerOptions.thoughtLevel === "string" &&
            providerOptions.thoughtLevel.trim().length > 0
            ? providerOptions.thoughtLevel
            : "reasoningEffort" in providerOptions &&
                typeof providerOptions.reasoningEffort === "string" &&
                providerOptions.reasoningEffort.trim().length > 0
              ? providerOptions.reasoningEffort
              : null
          : null
        : providerOptions && "reasoningEffort" in providerOptions
          ? providerOptions.reasoningEffort
          : null;

  const promptEffort = resolveEffort(caps, rawEffort) ?? null;

  const normalizedOptions =
    provider === "codex"
      ? normalizeCodexModelOptionsWithCapabilities(caps, modelOptions?.codex)
      : provider === "claudeAgent"
        ? normalizeClaudeModelOptionsWithCapabilities(caps, modelOptions?.claudeAgent)
        : provider === "githubCopilot"
          ? normalizeGitHubCopilotModelOptionsWithCapabilities(caps, modelOptions?.githubCopilot)
          : provider === "cursor"
            ? normalizeCursorModelOptionsWithCapabilities(caps, modelOptions?.cursor)
            : provider === "pi"
              ? (normalizePiModelOptionsWithCapabilities(caps, modelOptions?.pi) ??
                modelOptions?.pi)
              : provider === "gemini"
                ? undefined
                : provider === "opencode"
                  ? normalizeOpenCodeModelOptionsWithCapabilities(caps, modelOptions?.opencode)
                  : undefined;

  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
    ...(ultrathinkActive ? { composerFrameClassName: "ultrathink-frame" } : {}),
    ...(ultrathinkActive
      ? {
          composerSurfaceClassName: "ring-2 ring-primary/30",
        }
      : {}),
    ...(ultrathinkActive ? { modelPickerIconClassName: "ultrathink-chroma" } : {}),
  };
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  if (input.provider === "cursor") {
    return {
      ...getProviderStateFromCapabilities(input),
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    };
  }
  return getProviderStateFromCapabilities(input);
}
