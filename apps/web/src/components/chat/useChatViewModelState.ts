import type { ModelSelection, ProviderKind, ServerProvider, ThreadId } from "@ace/contracts";
import type { UnifiedSettings } from "@ace/contracts/settings";
import { buildProviderModelSelection, normalizeModelSlug } from "@ace/shared/model";
import { useMemo } from "react";

import { useEffectiveComposerModelState } from "../../composerDraftStore";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import { getProviderModels, resolveSelectableProvider } from "../../providerModels";
import { AVAILABLE_PROVIDER_OPTIONS } from "./ProviderModelPicker";
import { getComposerProviderState } from "./composerProviderRegistry";

interface UseChatViewModelStateInput {
  readonly hasThreadStarted: boolean;
  readonly isServerThread: boolean;
  readonly modelSettings: Pick<UnifiedSettings, "providers">;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly prompt: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectedProviderByThreadId: ProviderKind | null;
  readonly sessionProvider: ProviderKind | null;
  readonly threadId: ThreadId;
  readonly threadModelSelection: ModelSelection | null | undefined;
}

interface UseChatViewModelStateResult {
  readonly activeProviderStatus: ServerProvider | null;
  readonly composerModelOptions: ReturnType<typeof useEffectiveComposerModelState>["modelOptions"];
  readonly composerProviderState: ReturnType<typeof getComposerProviderState>;
  readonly handoffTargetProviders: ReadonlyArray<ProviderKind>;
  readonly lockedProvider: ProviderKind | null;
  readonly modelOptionsByProvider: ReturnType<typeof getCustomModelOptionsByProvider>;
  readonly selectedModel: string;
  readonly selectedModelForPickerWithCustomFallback: string;
  readonly selectedModelSelection: ModelSelection;
  readonly selectedPromptEffort: ReturnType<typeof getComposerProviderState>["promptEffort"];
  readonly selectedProvider: ProviderKind;
  readonly selectedProviderModels: ReturnType<typeof getProviderModels>;
}

export function useChatViewModelState(
  input: UseChatViewModelStateInput,
): UseChatViewModelStateResult {
  const threadProvider =
    input.threadModelSelection?.provider ?? input.projectModelSelection?.provider ?? null;
  const lockedProvider: ProviderKind | null = input.hasThreadStarted
    ? (input.sessionProvider ?? threadProvider ?? input.selectedProviderByThreadId ?? null)
    : null;
  const unlockedSelectedProvider = resolveSelectableProvider(
    input.providers,
    input.selectedProviderByThreadId ?? threadProvider ?? "codex",
  );
  const selectedProvider: ProviderKind = lockedProvider ?? unlockedSelectedProvider;
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: input.threadId,
    providers: input.providers,
    selectedProvider,
    threadModelSelection: input.threadModelSelection,
    projectModelSelection: input.projectModelSelection,
    settings: input.modelSettings,
  });
  const selectedProviderModels = getProviderModels(input.providers, selectedProvider);
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt: input.prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, input.prompt, selectedModel, selectedProvider, selectedProviderModels],
  );
  const selectedModelSelection = useMemo<ModelSelection>(
    () =>
      buildProviderModelSelection(
        selectedProvider,
        selectedModel,
        composerProviderState.modelOptionsForDispatch,
      ),
    [composerProviderState.modelOptionsForDispatch, selectedModel, selectedProvider],
  );
  const modelOptionsByProvider = useMemo(
    () =>
      getCustomModelOptionsByProvider(
        input.modelSettings,
        input.providers,
        selectedProvider,
        selectedModel,
      ),
    [input.modelSettings, input.providers, selectedModel, selectedProvider],
  );
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModel)
      ? selectedModel
      : (normalizeModelSlug(selectedModel, selectedProvider) ?? selectedModel);
  }, [modelOptionsByProvider, selectedModel, selectedProvider]);
  const handoffTargetProviders = useMemo<ProviderKind[]>(() => {
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
  }, [input.isServerThread, input.providers, input.threadModelSelection]);
  const activeProviderStatus = useMemo(
    () => input.providers.find((status) => status.provider === selectedProvider) ?? null,
    [input.providers, selectedProvider],
  );

  return {
    activeProviderStatus,
    composerModelOptions,
    composerProviderState,
    handoffTargetProviders,
    lockedProvider,
    modelOptionsByProvider,
    selectedModel,
    selectedModelForPickerWithCustomFallback,
    selectedModelSelection,
    selectedPromptEffort: composerProviderState.promptEffort,
    selectedProvider,
    selectedProviderModels,
  };
}
