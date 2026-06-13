import {
  type ProviderKind,
  type ProviderModelOptions,
  type ProviderSessionConfigOption,
  type ServerProviderModel,
  type ThreadId,
} from "@ace/contracts";
import type { ReactNode } from "react";
import {
  TraitsMenuContent,
  TraitsPicker,
  CursorTraitsMenuContent,
  CursorTraitsPicker,
} from "./TraitsPicker";
import { shouldRenderTraitsPicker } from "./traitsPickerVisibility";
export { getComposerProviderState } from "./composerProviderState";
export type { ComposerProviderState, ComposerProviderStateInput } from "./composerProviderState";

type ProviderRegistryEntry = {
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

const composerProviderRegistry: Record<ProviderKind, ProviderRegistryEntry> = {
  codex: {
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
