import {
  type ProviderKind,
  type ProviderSessionConfigOption,
  type ServerProviderModel,
} from "@ace/contracts";

import { readCursorSelectedTraits, resolveCursorSelectorFamily } from "../../cursorModelSelector";
import {
  findPiThoughtConfigOption,
  getRawEffort,
  getSelectedTraits,
  hasVisibleCursorTraits,
  hasVisibleTraits,
  type TraitsProviderOptions,
} from "./traitsPickerVisibility";

const CURSOR_REASONING_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
} as const;

function buildCursorTriggerLabel(input: {
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  showFastInTriggerLabel?: boolean;
}): string | null {
  const family = resolveCursorSelectorFamily(input.models, input.model);
  if (!family || !hasVisibleCursorTraits(input.models, input.model)) {
    return null;
  }

  const selectedTraits = readCursorSelectedTraits({
    family,
    model: input.model,
  });
  const primaryLabel = selectedTraits?.reasoningEffort
    ? CURSOR_REASONING_LABELS[selectedTraits.reasoningEffort]
    : family.supportsThinkingToggle
      ? `Thinking ${selectedTraits?.thinking ? "On" : "Off"}`
      : family.supportsFastMode
        ? `Fast ${selectedTraits?.fastMode ? "On" : "Off"}`
        : family.supportsMaxMode
          ? `Max ${selectedTraits?.maxMode ? "On" : "Off"}`
          : "Variants";

  const showFastInTriggerLabel = input.showFastInTriggerLabel ?? true;
  return [
    primaryLabel,
    showFastInTriggerLabel && selectedTraits?.fastMode && !primaryLabel.startsWith("Fast")
      ? "Fast"
      : null,
    selectedTraits?.thinking && !primaryLabel.startsWith("Thinking") ? "Thinking" : null,
    selectedTraits?.maxMode && !primaryLabel.startsWith("Max") ? "Max" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function buildProviderTraitsTriggerLabel(input: {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions?: TraitsProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  showFastInTriggerLabel?: boolean;
  sessionConfigOptions?: ReadonlyArray<ProviderSessionConfigOption> | undefined;
}): string | null {
  const showFastInTriggerLabel = input.showFastInTriggerLabel ?? true;

  if (input.provider === "cursor") {
    return buildCursorTriggerLabel({
      models: input.models,
      model: input.model,
      showFastInTriggerLabel,
    });
  }

  if (input.provider === "pi") {
    const piThoughtOption = findPiThoughtConfigOption(input.sessionConfigOptions);
    if (piThoughtOption && piThoughtOption.options.length > 0) {
      const selectedThoughtLevel =
        getRawEffort(input.provider, input.modelOptions) ?? piThoughtOption.currentValue;
      return (
        piThoughtOption.options.find((option) => option.value === selectedThoughtLevel)?.name ??
        null
      );
    }
  }

  const {
    caps,
    contextWindow,
    contextWindowOptions,
    defaultContextWindow,
    effort,
    effortLevels,
    fastModeEnabled,
    thinkingEnabled,
    ultrathinkPromptControlled,
  } = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
  );

  if (
    !hasVisibleTraits({
      contextWindowOptions,
      effortLevels,
      supportsFastMode: caps.supportsFastMode,
      thinkingEnabled,
    })
  ) {
    return null;
  }

  const effortLabel = effort
    ? (effortLevels.find((level) => level.value === effort)?.label ?? effort)
    : null;
  const contextWindowLabel =
    contextWindowOptions.length > 1 &&
    (input.provider === "opencode" || contextWindow !== defaultContextWindow)
      ? (contextWindowOptions.find((option) => option.value === contextWindow)?.label ?? null)
      : null;

  const triggerLabel = [
    ultrathinkPromptControlled
      ? "Ultrathink"
      : effortLabel
        ? effortLabel
        : thinkingEnabled === null
          ? null
          : `Thinking ${thinkingEnabled ? "On" : "Off"}`,
    ...(showFastInTriggerLabel && caps.supportsFastMode && fastModeEnabled ? ["Fast"] : []),
    ...(contextWindowLabel ? [contextWindowLabel] : []),
  ]
    .filter(Boolean)
    .join(" · ");

  return triggerLabel || null;
}
