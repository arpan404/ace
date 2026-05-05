import {
  type ProviderKind,
  type ProviderModelOptions,
  type ProviderSessionConfigOption,
  type ServerProviderModel,
  type ThreadId,
} from "@ace/contracts";
import { isClaudeUltrathinkPrompt, resolveEffort } from "@ace/shared/model";
import type { ReactNode } from "react";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  shouldRenderTraitsPicker,
  TraitsMenuContent,
  TraitsPicker,
  CursorTraitsMenuContent,
  CursorTraitsPicker,
} from "./TraitsPicker";
import {
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
  normalizeGitHubCopilotModelOptionsWithCapabilities,
  normalizeOpenCodeModelOptionsWithCapabilities,
  normalizePiModelOptionsWithCapabilities,
} from "@ace/shared/model";

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

type ProviderRegistryEntry = {
  getState: (input: ComposerProviderStateInput) => ComposerProviderState;
  renderTraitsMenuContent: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
    sessionConfigOptions?: ReadonlyArray<ProviderSessionConfigOption> | undefined;
  }) => ReactNode;
  renderTraitsPicker: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
    showFastInTriggerLabel?: boolean;
    sessionConfigOptions?: ReadonlyArray<ProviderSessionConfigOption> | undefined;
  }) => ReactNode;
};

function getProviderStateFromCapabilities(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const { provider, model, models, prompt, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const providerOptions = modelOptions?.[provider];

  // Resolve effort
  const rawEffort = providerOptions
    ? "effort" in providerOptions
      ? providerOptions.effort
      : "reasoningEffort" in providerOptions
        ? providerOptions.reasoningEffort
        : null
    : null;

  const promptEffort = resolveEffort(caps, rawEffort) ?? null;

  // Normalize options for dispatch
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

  // Ultrathink styling (driven by capabilities data, not provider identity)
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

const composerProviderRegistry: Record<ProviderKind, ProviderRegistryEntry> = {
  codex: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) => (
      <TraitsMenuContent
        provider="codex"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
      />
    ),
    renderTraitsPicker: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      showFastInTriggerLabel,
    }) => (
      <TraitsPicker
        provider="codex"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
        {...(typeof showFastInTriggerLabel === "boolean" ? { showFastInTriggerLabel } : {})}
      />
    ),
  },
  claudeAgent: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) => (
      <TraitsMenuContent
        provider="claudeAgent"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
      />
    ),
    renderTraitsPicker: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      showFastInTriggerLabel,
    }) => (
      <TraitsPicker
        provider="claudeAgent"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
        {...(typeof showFastInTriggerLabel === "boolean" ? { showFastInTriggerLabel } : {})}
      />
    ),
  },
  githubCopilot: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) => (
      <TraitsMenuContent
        provider="githubCopilot"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
      />
    ),
    renderTraitsPicker: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      showFastInTriggerLabel,
    }) => (
      <TraitsPicker
        provider="githubCopilot"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
        {...(typeof showFastInTriggerLabel === "boolean" ? { showFastInTriggerLabel } : {})}
      />
    ),
  },
  cursor: {
    getState: (input) => ({
      ...getProviderStateFromCapabilities(input),
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    }),
    renderTraitsMenuContent: ({ threadId, model, models }) => (
      <CursorTraitsMenuContent threadId={threadId} model={model} models={models} />
    ),
    renderTraitsPicker: ({ threadId, model, models, showFastInTriggerLabel }) => (
      <CursorTraitsPicker
        threadId={threadId}
        model={model}
        models={models}
        {...(typeof showFastInTriggerLabel === "boolean" ? { showFastInTriggerLabel } : {})}
      />
    ),
  },
  pi: {
    getState: (input) => ({
      ...getProviderStateFromCapabilities(input),
      promptEffort: null,
      modelOptionsForDispatch: input.modelOptions?.pi,
    }),
    renderTraitsMenuContent: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      sessionConfigOptions,
    }) => (
      <TraitsMenuContent
        provider="pi"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
        sessionConfigOptions={sessionConfigOptions}
      />
    ),
    renderTraitsPicker: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      sessionConfigOptions,
    }) => (
      <TraitsPicker
        provider="pi"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
        sessionConfigOptions={sessionConfigOptions}
      />
    ),
  },
  gemini: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) => (
      <TraitsMenuContent
        provider="gemini"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
      />
    ),
    renderTraitsPicker: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      showFastInTriggerLabel,
    }) => (
      <TraitsPicker
        provider="gemini"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
        {...(typeof showFastInTriggerLabel === "boolean" ? { showFastInTriggerLabel } : {})}
      />
    ),
  },
  opencode: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
    }) => (
      <TraitsMenuContent
        provider="opencode"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
      />
    ),
    renderTraitsPicker: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      showFastInTriggerLabel,
    }) => (
      <TraitsPicker
        provider="opencode"
        models={models}
        threadId={threadId}
        model={model}
        modelOptions={modelOptions}
        prompt={prompt}
        onPromptChange={onPromptChange}
        {...(typeof showFastInTriggerLabel === "boolean" ? { showFastInTriggerLabel } : {})}
      />
    ),
  },
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  return composerProviderRegistry[input.provider].getState(input);
}

export function renderProviderTraitsMenuContent(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  sessionConfigOptions?: ReadonlyArray<ProviderSessionConfigOption> | undefined;
}): ReactNode {
  if (
    !shouldRenderTraitsPicker({
      provider: input.provider,
      models: input.models,
      model: input.model,
      modelOptions: input.modelOptions,
      prompt: input.prompt,
      sessionConfigOptions: input.sessionConfigOptions,
    })
  ) {
    return null;
  }

  return composerProviderRegistry[input.provider].renderTraitsMenuContent({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
    sessionConfigOptions: input.sessionConfigOptions,
  });
}

export function renderProviderTraitsPicker(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  showFastInTriggerLabel?: boolean;
  sessionConfigOptions?: ReadonlyArray<ProviderSessionConfigOption> | undefined;
}): ReactNode {
  if (
    !shouldRenderTraitsPicker({
      provider: input.provider,
      models: input.models,
      model: input.model,
      modelOptions: input.modelOptions,
      prompt: input.prompt,
      sessionConfigOptions: input.sessionConfigOptions,
    })
  ) {
    return null;
  }

  return composerProviderRegistry[input.provider].renderTraitsPicker({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
    sessionConfigOptions: input.sessionConfigOptions,
    ...(typeof input.showFastInTriggerLabel === "boolean"
      ? { showFastInTriggerLabel: input.showFastInTriggerLabel }
      : {}),
  });
}
