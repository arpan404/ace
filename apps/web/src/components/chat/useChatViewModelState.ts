import type { ModelSelection, ProviderKind, ServerProvider } from "@ace/contracts";
import type { UnifiedSettings } from "@ace/contracts/settings";
import { buildProviderModelSelection, normalizeModelSlug } from "@ace/shared/model";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { deriveEffectiveComposerModelState } from "../../composerDraftStore";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import {
  getProviderModels,
  getProviderSnapshot,
  resolveSelectableProvider,
} from "../../providerModels";
import { getComposerProviderState } from "./composerProviderRegistry";
import { AVAILABLE_PROVIDER_OPTIONS } from "./providerModelPickerOptions";

type ComposerModelDraftState =
  | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
  | null
  | undefined;

interface ChatViewProviderSelectionInput {
  readonly draft: ComposerModelDraftState;
  readonly hasThreadStarted: boolean;
  readonly isServerThread: boolean;
  readonly lockProvider?: boolean | undefined;
  readonly modelSettings: Pick<UnifiedSettings, "providers">;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sessionProvider: ProviderKind | null;
  readonly threadModelSelection: ModelSelection | null | undefined;
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

export function deriveChatViewProviderSelectionState(
  input: ChatViewProviderSelectionInput,
): ChatViewProviderSelectionState {
  const threadProvider =
    input.threadModelSelection?.provider ?? input.projectModelSelection?.provider ?? null;
  const lockedProvider: ProviderKind | null =
    input.hasThreadStarted || input.lockProvider === true
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
  const draftSelection = input.draft?.modelSelectionByProvider?.[selectedProvider];
  const selectedProviderInstanceId =
    draftSelection !== undefined
      ? draftSelection.providerInstanceId
      : ((input.threadModelSelection?.provider === selectedProvider
          ? input.threadModelSelection.providerInstanceId
          : undefined) ??
        (input.projectModelSelection?.provider === selectedProvider
          ? input.projectModelSelection.providerInstanceId
          : undefined));
  const selectedProviderModels = getProviderModels(
    input.providers,
    selectedProvider,
    selectedProviderInstanceId,
  );
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
    selectedProviderInstanceId,
  );
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    input.modelSettings,
    input.providers,
    selectedProvider,
    selectedModel,
    selectedProviderInstanceId,
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
    const enabledProviders = new Set<ProviderKind>();
    for (const provider of input.providers) {
      if (provider.enabled && provider.status !== "disabled") {
        enabledProviders.add(provider.provider);
      }
    }

    const targetProviders: ProviderKind[] = [];
    for (const option of AVAILABLE_PROVIDER_OPTIONS) {
      const provider = option.value;
      if (provider !== fromProvider && enabledProviders.has(provider)) {
        targetProviders.push(provider);
      }
    }
    return targetProviders;
  })();
  const activeProviderStatus =
    getProviderSnapshot(input.providers, selectedProvider, selectedProviderInstanceId) ?? null;

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
    lockProvider,
    modelSettings,
    projectModelSelection,
    providers,
    sessionProvider,
    threadModelSelection,
  } = input;

  return deriveChatViewProviderSelectionState({
    draft,
    hasThreadStarted,
    isServerThread,
    lockProvider,
    modelSettings,
    projectModelSelection,
    providers,
    sessionProvider,
    threadModelSelection,
  });
}
