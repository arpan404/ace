import type { ModelSelection, ProviderKind, ServerProvider } from "@ace/contracts";
import type { UnifiedSettings } from "@ace/contracts/settings";
import { buildProviderModelSelection, normalizeModelSlug } from "@ace/shared/model";
import { useMemo } from "react";

import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { deriveEffectiveComposerModelState } from "../../composerDraftStore";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import { getProviderModels, resolveSelectableProvider } from "../../providerModels";
import { AVAILABLE_PROVIDER_OPTIONS } from "./ProviderModelPicker";
import { getComposerProviderState } from "./composerProviderRegistry";

type ComposerModelDraftState =
  | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
  | null
  | undefined;

interface ChatViewProviderSelectionInput {
  readonly draft: ComposerModelDraftState;
  readonly hasThreadStarted: boolean;
  readonly isServerThread: boolean;
  readonly modelSettings: Pick<UnifiedSettings, "providers">;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sessionProvider: ProviderKind | null;
  readonly threadModelSelection: ModelSelection | null | undefined;
}

interface UseChatViewModelStateInput extends ChatViewProviderSelectionInput {
  readonly prompt: string;
}

export interface ChatViewProviderSelectionState {
  readonly activeProviderStatus: ServerProvider | null;
  readonly composerModelOptions: ReturnType<
    typeof deriveEffectiveComposerModelState
  >["modelOptions"];
  readonly handoffTargetProviders: ReadonlyArray<ProviderKind>;
  readonly lockedProvider: ProviderKind | null;
  readonly modelOptionsByProvider: ReturnType<typeof getCustomModelOptionsByProvider>;
  readonly selectedModel: string;
  readonly selectedModelForPickerWithCustomFallback: string;
  readonly selectedModelSelection: ModelSelection;
  readonly selectedProvider: ProviderKind;
  readonly selectedProviderModels: ReturnType<typeof getProviderModels>;
}

interface UseChatViewModelStateResult extends ChatViewProviderSelectionState {
  readonly composerProviderState: ReturnType<typeof getComposerProviderState>;
  readonly selectedPromptEffort: ReturnType<typeof getComposerProviderState>["promptEffort"];
}

export function deriveChatViewProviderSelectionState(
  input: ChatViewProviderSelectionInput,
): ChatViewProviderSelectionState {
  const threadProvider =
    input.threadModelSelection?.provider ?? input.projectModelSelection?.provider ?? null;
  const lockedProvider: ProviderKind | null = input.hasThreadStarted
    ? (input.sessionProvider ?? threadProvider ?? input.draft?.activeProvider ?? null)
    : null;
  const unlockedSelectedProvider = resolveSelectableProvider(
    input.providers,
    input.draft?.activeProvider ?? threadProvider ?? "codex",
  );
  const selectedProvider: ProviderKind = lockedProvider ?? unlockedSelectedProvider;
  const { modelOptions: composerModelOptions, selectedModel } = deriveEffectiveComposerModelState({
    draft: input.draft,
    providers: input.providers,
    selectedProvider,
    threadModelSelection: input.threadModelSelection,
    projectModelSelection: input.projectModelSelection,
    settings: input.modelSettings,
  });
  const selectedProviderModels = getProviderModels(input.providers, selectedProvider);
  const composerProviderState = getComposerProviderState({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderModels,
    prompt: "",
    modelOptions: composerModelOptions,
  });
  const selectedModelSelection = buildProviderModelSelection(
    selectedProvider,
    selectedModel,
    composerProviderState.modelOptionsForDispatch,
  );
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    input.modelSettings,
    input.providers,
    selectedProvider,
    selectedModel,
  );
  const selectedModelForPickerWithCustomFallback = (() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModel)
      ? selectedModel
      : (normalizeModelSlug(selectedModel, selectedProvider) ?? selectedModel);
  })();
  const handoffTargetProviders: ProviderKind[] = (() => {
    if (!input.threadModelSelection || !input.isServerThread) {
      return [];
    }

    const fromProvider = input.threadModelSelection.provider;
    const enabledProviders = new Set(
      input.providers
        .filter((provider) => provider.enabled && provider.status !== "disabled")
        .map((provider) => provider.provider),
    );

    return AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value).filter(
      (provider) => provider !== fromProvider && enabledProviders.has(provider),
    );
  })();
  const activeProviderStatus =
    input.providers.find((status) => status.provider === selectedProvider) ?? null;

  return {
    activeProviderStatus,
    composerModelOptions,
    handoffTargetProviders,
    lockedProvider,
    modelOptionsByProvider,
    selectedModel,
    selectedModelForPickerWithCustomFallback,
    selectedModelSelection,
    selectedProvider,
    selectedProviderModels,
  };
}

export function useChatViewProviderSelectionState(
  input: ChatViewProviderSelectionInput,
): ChatViewProviderSelectionState {
  const {
    draft,
    hasThreadStarted,
    isServerThread,
    modelSettings,
    projectModelSelection,
    providers,
    sessionProvider,
    threadModelSelection,
  } = input;

  return useMemo(
    () =>
      deriveChatViewProviderSelectionState({
        draft,
        hasThreadStarted,
        isServerThread,
        modelSettings,
        projectModelSelection,
        providers,
        sessionProvider,
        threadModelSelection,
      }),
    [
      draft,
      hasThreadStarted,
      isServerThread,
      modelSettings,
      projectModelSelection,
      providers,
      sessionProvider,
      threadModelSelection,
    ],
  );
}

export function useChatViewModelState(
  input: UseChatViewModelStateInput,
): UseChatViewModelStateResult {
  const selectionState = useChatViewProviderSelectionState(input);
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectionState.selectedProvider,
        model: selectionState.selectedModel,
        models: selectionState.selectedProviderModels,
        prompt: input.prompt,
        modelOptions: selectionState.composerModelOptions,
      }),
    [
      input.prompt,
      selectionState.composerModelOptions,
      selectionState.selectedModel,
      selectionState.selectedProvider,
      selectionState.selectedProviderModels,
    ],
  );

  return {
    ...selectionState,
    composerProviderState,
    selectedPromptEffort: composerProviderState.promptEffort,
  };
}
