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
  type ThreadId,
} from "@ace/contracts";
import { applyClaudePromptEffortPrefix, buildProviderModelSelection } from "@ace/shared/model";
import { type ReactElement, type ReactNode, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon, ZapIcon } from "lucide-react";
import { IconBoltFilled } from "@tabler/icons-react";
import { Button } from "../ui/button";
import { buttonVariants } from "../ui/buttonVariants";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";
import { cn } from "~/lib/utils";
import { APP_SETTINGS_PICKER_TRIGGER_CLASS_NAME } from "~/lib/appChrome";
import {
  findPiThoughtConfigOption,
  getRawEffort,
  getSelectedTraits,
  hasVisibleTraits,
  hasVisibleCursorTraits,
  type TraitsProviderOptions,
} from "./traitsPickerVisibility";

function traitsPickerTriggerVariant(
  triggerSurface: "composer" | "settings" | undefined,
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"],
) {
  return triggerSurface === "settings" ? "ghost" : (triggerVariant ?? "ghost");
}

function traitsPickerTriggerClassName(
  triggerSurface: "composer" | "settings" | undefined,
  isCodexStyle: boolean,
  triggerClassName?: string,
) {
  if (triggerSurface === "settings") {
    return cn(
      APP_SETTINGS_PICKER_TRIGGER_CLASS_NAME,
      "min-w-0 max-w-none shrink-0",
      triggerClassName,
    );
  }

  return cn(
    isCodexStyle
      ? "h-8 min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap rounded-full px-2.5 text-[13px] text-muted-foreground/68 transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground/88 sm:max-w-48 [&_svg]:mx-0"
      : "h-8 shrink-0 whitespace-nowrap rounded-full px-2.5 text-[13px] text-muted-foreground/68 transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground/88",
    triggerClassName,
  );
}
import {
  cursorFacetValues,
  pickCursorModelFromTraits,
  readCursorSelectedTraits,
  resolveCursorSelectorFamily,
  type CursorSelectorFamily,
  type CursorSelectorReasoningEffort,
} from "../../cursorModelSelector";

type ProviderOptions = TraitsProviderOptions;
type TraitsPersistence =
  | {
      threadId: ThreadId;
      onModelOptionsChange?: never;
    }
  | {
      threadId?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";
const CURSOR_REASONING_LABELS: Record<CursorSelectorReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function TraitSection(props: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 px-0.5 py-1">
      <div className="px-1 text-[9.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/58">
        {props.label}
      </div>
      {props.children}
    </div>
  );
}

function TraitSegmentedGrid(props: {
  children: ReactElement | ReadonlyArray<ReactElement>;
  columns?: 1 | 2 | 3 | 4;
}) {
  return (
    <div
      className={cn(
        "grid gap-1",
        props.columns === 1
          ? "grid-cols-1"
          : props.columns === 4
            ? "grid-cols-4"
            : props.columns === 3
              ? "grid-cols-3"
              : "grid-cols-2",
      )}
    >
      {props.children}
    </div>
  );
}

function TraitSegmentedOption(props: {
  align?: "center" | "start";
  disabled?: boolean;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      disabled={props.disabled}
      className={cn(
        "min-h-7 rounded-[0.6rem] px-2 text-center text-[12px] leading-none outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
        props.align === "start" && "text-left",
        props.selected
          ? "bg-foreground/[0.105] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/.045)] dark:bg-white/[0.12]"
          : "text-muted-foreground/74 hover:bg-foreground/[0.06] hover:text-foreground/90 dark:hover:bg-white/[0.08]",
        props.disabled && "pointer-events-none opacity-40",
      )}
      onClick={props.onSelect}
    >
      {props.label}
    </button>
  );
}

function TraitSwitchItem(props: {
  checked: boolean;
  disabled?: boolean | undefined;
  icon?: ReactElement | undefined;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <MenuCheckboxItem
      variant="switch"
      checked={props.checked}
      disabled={props.disabled}
      className="min-h-8 rounded-[0.7rem] px-2 text-[12.5px] text-foreground/90 hover:bg-foreground/[0.055] dark:hover:bg-white/[0.07] [&_[data-slot=menu-checkbox-indicator]]:h-[1.125rem] [&_[data-slot=menu-checkbox-indicator]]:w-8 [&_[data-slot=menu-checkbox-indicator]]:data-checked:bg-primary/90 [&_[data-slot=menu-checkbox-thumb]]:h-4 [&_[data-slot=menu-checkbox-thumb]]:in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[0.875rem]"
      onCheckedChange={(checked) => props.onCheckedChange(Boolean(checked))}
    >
      <span className="flex min-w-0 items-center gap-2">
        {props.icon ? (
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/72">
            {props.icon}
          </span>
        ) : null}
        <span className="truncate">{props.label}</span>
      </span>
    </MenuCheckboxItem>
  );
}

function buildPiOptionsFromThoughtLevel(
  modelOptions: ProviderOptions | null | undefined,
  value: string,
): PiModelOptions {
  return {
    ...(modelOptions as PiModelOptions | undefined),
    thoughtLevel: value as PiModelOptions["thoughtLevel"],
    ...(value === "low" || value === "medium" || value === "high" || value === "xhigh"
      ? {
          reasoningEffort: value as NonNullable<PiModelOptions["reasoningEffort"]>,
        }
      : {}),
  };
}

function buildNextOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  switch (provider) {
    case "codex":
      return {
        ...(modelOptions as CodexModelOptions | undefined),
        ...patch,
      } as CodexModelOptions;
    case "githubCopilot":
      return {
        ...(modelOptions as GitHubCopilotModelOptions | undefined),
        ...patch,
      } as GitHubCopilotModelOptions;
    case "cursor":
      return {
        ...(modelOptions as CursorModelOptions | undefined),
        ...patch,
      } as CursorModelOptions;
    case "claudeAgent":
      return {
        ...(modelOptions as ClaudeModelOptions | undefined),
        ...patch,
      } as ClaudeModelOptions;
    case "pi":
      return {
        ...(modelOptions as PiModelOptions | undefined),
        ...patch,
      } as PiModelOptions;
    case "gemini":
      return {} as ProviderModelOptions["gemini"];
    case "opencode":
      return {
        ...(modelOptions as OpenCodeModelOptions | undefined),
        ...(typeof patch.contextWindow === "string" ? { variant: patch.contextWindow } : {}),
        ...(typeof patch.fastMode === "boolean" ? { fastMode: patch.fastMode } : {}),
      } as OpenCodeModelOptions;
  }
}

function buildCursorTriggerLabel(input: {
  family: CursorSelectorFamily;
  model: string | null | undefined;
  showFastInTriggerLabel?: boolean;
}): string {
  const selectedTraits = readCursorSelectedTraits(input);
  const primaryLabel = selectedTraits.reasoningEffort
    ? CURSOR_REASONING_LABELS[selectedTraits.reasoningEffort]
    : input.family.supportsThinkingToggle
      ? `Thinking ${selectedTraits.thinking ? "On" : "Off"}`
      : input.family.supportsFastMode
        ? `Fast ${selectedTraits.fastMode ? "On" : "Off"}`
        : input.family.supportsMaxMode
          ? `Max ${selectedTraits.maxMode ? "On" : "Off"}`
          : "Variants";
  const showFastInTriggerLabel = input.showFastInTriggerLabel ?? true;
  return [
    primaryLabel,
    showFastInTriggerLabel && selectedTraits.fastMode && !primaryLabel.startsWith("Fast")
      ? "Fast"
      : null,
    selectedTraits.thinking && !primaryLabel.startsWith("Thinking") ? "Thinking" : null,
    selectedTraits.maxMode && !primaryLabel.startsWith("Max") ? "Max" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function CursorTraitsMenuContent(props: {
  threadId: ThreadId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
}) {
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const setStickyModelSelection = useComposerDraftStore((store) => store.setStickyModelSelection);
  const family = resolveCursorSelectorFamily(props.models, props.model);

  const applySelection = (nextModelSlug: string) => {
    const modelSelection = buildProviderModelSelection("cursor", nextModelSlug);
    setModelSelection(props.threadId, modelSelection);
    setProviderModelOptions(props.threadId, "cursor", undefined, { persistSticky: true });
    setStickyModelSelection(modelSelection);
  };

  if (!family) {
    return null;
  }

  const selectedTraits = readCursorSelectedTraits({
    family,
    model: props.model,
  });
  const renderBinaryFacet = (
    key: "thinking" | "fastMode" | "maxMode",
    label: string,
    selectedValue: boolean | undefined,
  ) => {
    const values = cursorFacetValues(family, key, selectedTraits);
    if (values.length < 2) {
      return null;
    }
    return (
      <TraitSection key={`cursor-${key}`} label={label}>
        <TraitSwitchItem
          checked={Boolean(selectedValue)}
          disabled={!values.includes(selectedValue ? "false" : "true")}
          {...(key === "fastMode"
            ? { icon: <IconBoltFilled aria-hidden="true" className="size-3" /> }
            : {})}
          label={label}
          onCheckedChange={(checked) => {
            const nextModel = pickCursorModelFromTraits({
              family,
              selections: {
                ...selectedTraits,
                [key]: checked,
              },
            });
            if (nextModel) {
              applySelection(nextModel.slug);
            }
          }}
        />
      </TraitSection>
    );
  };

  const sections = [
    family.reasoningEffortOptions.length > 0 ? (
      <TraitSection key="cursor-effort" label="Reasoning">
        <TraitSegmentedGrid columns={1}>
          {family.reasoningEffortOptions.map((option) => (
            <TraitSegmentedOption
              key={`cursor-effort:${option}`}
              align="start"
              label={CURSOR_REASONING_LABELS[option]}
              selected={(selectedTraits.reasoningEffort ?? "medium") === option}
              disabled={
                !cursorFacetValues(family, "reasoningEffort", selectedTraits).includes(option)
              }
              onSelect={() => {
                const nextModel = pickCursorModelFromTraits({
                  family,
                  selections: {
                    ...selectedTraits,
                    reasoningEffort: option,
                  },
                });
                if (nextModel) {
                  applySelection(nextModel.slug);
                }
              }}
            />
          ))}
        </TraitSegmentedGrid>
      </TraitSection>
    ) : null,
    renderBinaryFacet("thinking", "Thinking", selectedTraits.thinking),
    renderBinaryFacet("fastMode", "Speed", selectedTraits.fastMode),
    renderBinaryFacet("maxMode", "Max", selectedTraits.maxMode),
  ].filter((section): section is ReactElement => section !== null);

  return <div className="space-y-1">{sections}</div>;
}

export function CursorTraitsPicker(props: {
  threadId: ThreadId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  showFastInTriggerLabel?: boolean;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const family = resolveCursorSelectorFamily(props.models, props.model);

  if (!family || !hasVisibleCursorTraits(props.models, props.model)) {
    return null;
  }

  const showFastInTriggerLabel = props.showFastInTriggerLabel ?? true;
  const triggerLabel = buildCursorTriggerLabel({
    family,
    model: props.model,
    ...(!showFastInTriggerLabel ? { showFastInTriggerLabel } : {}),
  });
  const selectedTraits = readCursorSelectedTraits({
    family,
    model: props.model,
  });
  const showFastIconInTrigger =
    family.supportsFastMode && selectedTraits.fastMode && !showFastInTriggerLabel;

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="h-8 min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap rounded-full px-2.5 text-[13px] text-muted-foreground/68 transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground/88 sm:max-w-48 [&_svg]:mx-0"
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
          {showFastIconInTrigger ? (
            <ZapIcon aria-hidden="true" className="size-3.5 shrink-0" />
          ) : null}
          {triggerLabel}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <CursorTraitsMenuContent
          threadId={props.threadId}
          models={props.models}
          model={props.model}
        />
      </MenuPopup>
    </Menu>
  );
}

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  showFastInTriggerLabel?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  triggerSurface?: "composer" | "settings";
  sessionConfigOptions?: ReadonlyArray<ProviderSessionConfigOption> | undefined;
}

export function TraitsMenuContent({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  sessionConfigOptions,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const baseModelSelection = model ? buildProviderModelSelection(provider, model) : null;
  const updateModelOptions = (nextOptions: ProviderOptions | undefined) => {
    if ("onModelOptionsChange" in persistence) {
      persistence.onModelOptionsChange(nextOptions);
      return;
    }
    setProviderModelOptions(persistence.threadId, provider, nextOptions, {
      persistSticky: true,
      baseModelSelection,
    });
  };
  const piThoughtOption =
    provider === "pi" ? findPiThoughtConfigOption(sessionConfigOptions) : undefined;
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  } = getSelectedTraits(provider, models, model, prompt, modelOptions, allowPromptInjectedEffort);
  const handleEffortChange = (value: string) => {
    if (!value) return;
    const nextOption = effortLevels.find((option) => option.value === value);
    if (!nextOption) return;
    if (caps.promptInjectedEffortLevels.includes(nextOption.value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      return;
    }
    if (ultrathinkInBodyText) return;
    if (ultrathinkPromptControlled) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }
    if (provider === "pi") {
      updateModelOptions(buildPiOptionsFromThoughtLevel(modelOptions, nextOption.value));
      return;
    }
    const effortKey = provider === "claudeAgent" ? "effort" : "reasoningEffort";
    updateModelOptions(
      buildNextOptions(provider, modelOptions, {
        [effortKey]: nextOption.value,
      }),
    );
  };
  if (provider === "pi" && piThoughtOption && piThoughtOption.options.length > 0) {
    const selectedThoughtLevel =
      getRawEffort(provider, modelOptions) ?? piThoughtOption.currentValue;
    return (
      <TraitSection label="Thinking">
        <TraitSegmentedGrid columns={1}>
          {piThoughtOption.options.map((option) => (
            <TraitSegmentedOption
              key={option.value}
              align="start"
              label={option.name}
              selected={selectedThoughtLevel === option.value}
              onSelect={() => {
                updateModelOptions(buildPiOptionsFromThoughtLevel(modelOptions, option.value));
              }}
            />
          ))}
        </TraitSegmentedGrid>
      </TraitSection>
    );
  }

  if (
    !hasVisibleTraits({
      effortLevels,
      thinkingEnabled,
      supportsFastMode: caps.supportsFastMode,
      contextWindowOptions,
    })
  ) {
    return null;
  }

  const contextTraitLabel = provider === "opencode" ? "Variant" : "Context Window";
  const sections: Array<ReactElement> = [];

  if (effort) {
    sections.push(
      <TraitSection key="effort" label="Reasoning">
        {ultrathinkInBodyText ? (
          <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
            Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change effort.
          </div>
        ) : null}
        <TraitSegmentedGrid columns={1}>
          {effortLevels.map((option) => (
            <TraitSegmentedOption
              key={option.value}
              align="start"
              label={option.label}
              selected={(ultrathinkPromptControlled ? "ultrathink" : effort) === option.value}
              disabled={ultrathinkInBodyText}
              onSelect={() => handleEffortChange(option.value)}
            />
          ))}
        </TraitSegmentedGrid>
      </TraitSection>,
    );
  } else if (thinkingEnabled !== null) {
    sections.push(
      <TraitSection key="thinking" label="Thinking">
        <TraitSwitchItem
          checked={thinkingEnabled}
          label="Thinking"
          onCheckedChange={(checked) => {
            updateModelOptions(
              buildNextOptions(provider, modelOptions, {
                thinking: checked,
              }),
            );
          }}
        />
      </TraitSection>,
    );
  }

  if (caps.supportsFastMode) {
    sections.push(
      <TraitSection key="fast-mode" label="Speed">
        <TraitSwitchItem
          checked={fastModeEnabled}
          icon={<IconBoltFilled aria-hidden="true" className="size-3" />}
          label="Fast Mode"
          onCheckedChange={(checked) => {
            updateModelOptions(
              buildNextOptions(provider, modelOptions, {
                fastMode: checked,
              }),
            );
          }}
        />
      </TraitSection>,
    );
  }

  if (contextWindowOptions.length > 1) {
    sections.push(
      <TraitSection key="context-window" label={contextTraitLabel}>
        <TraitSegmentedGrid
          columns={contextWindowOptions.length >= 4 ? 4 : contextWindowOptions.length >= 3 ? 3 : 2}
        >
          {contextWindowOptions.map((option) => (
            <TraitSegmentedOption
              key={option.value}
              label={option.label}
              selected={(contextWindow ?? defaultContextWindow ?? "") === option.value}
              onSelect={() => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    contextWindow: option.value,
                  }),
                );
              }}
            />
          ))}
        </TraitSegmentedGrid>
      </TraitSection>,
    );
  }

  return <div className="space-y-1">{sections}</div>;
}

export function TraitsPicker({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  showFastInTriggerLabel = true,
  triggerVariant,
  triggerClassName,
  triggerSurface,
  sessionConfigOptions,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const piThoughtOption =
    provider === "pi" ? findPiThoughtConfigOption(sessionConfigOptions) : undefined;
  if (provider === "pi" && piThoughtOption && piThoughtOption.options.length > 0) {
    const selectedThoughtLevel =
      getRawEffort(provider, modelOptions) ?? piThoughtOption.currentValue;
    const triggerLabel =
      piThoughtOption.options.find((option) => option.value === selectedThoughtLevel)?.name ??
      "Thinking";
    return (
      <Menu
        open={isMenuOpen}
        onOpenChange={(open) => {
          setIsMenuOpen(open);
        }}
      >
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant={traitsPickerTriggerVariant(triggerSurface, triggerVariant)}
              className={traitsPickerTriggerClassName(triggerSurface, false, triggerClassName)}
            />
          }
        >
          <span>{triggerLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start">
          <TraitsMenuContent
            provider={provider}
            models={models}
            model={model}
            prompt={prompt}
            onPromptChange={onPromptChange}
            modelOptions={modelOptions}
            allowPromptInjectedEffort={allowPromptInjectedEffort}
            sessionConfigOptions={sessionConfigOptions}
            {...persistence}
          />
        </MenuPopup>
      </Menu>
    );
  }
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getSelectedTraits(provider, models, model, prompt, modelOptions, allowPromptInjectedEffort);

  const effortLabel = effort
    ? (effortLevels.find((l) => l.value === effort)?.label ?? effort)
    : null;
  const contextWindowLabel =
    contextWindowOptions.length > 1 &&
    (provider === "opencode" || contextWindow !== defaultContextWindow)
      ? (contextWindowOptions.find((o) => o.value === contextWindow)?.label ?? null)
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
  const resolvedTriggerLabel = triggerLabel || (provider === "opencode" ? "Variant" : "Traits");

  const isCodexStyle = provider === "codex" || provider === "githubCopilot";
  const showFastIconInTrigger = caps.supportsFastMode && fastModeEnabled && !showFastInTriggerLabel;

  if (
    !hasVisibleTraits({
      effortLevels,
      thinkingEnabled,
      supportsFastMode: caps.supportsFastMode,
      contextWindowOptions,
    })
  ) {
    return null;
  }

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={traitsPickerTriggerVariant(triggerSurface, triggerVariant)}
            className={traitsPickerTriggerClassName(triggerSurface, isCodexStyle, triggerClassName)}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            {showFastIconInTrigger ? (
              <ZapIcon aria-hidden="true" className="size-3.5 shrink-0" />
            ) : null}
            {resolvedTriggerLabel}
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </span>
        ) : (
          <>
            {showFastIconInTrigger ? <ZapIcon aria-hidden="true" className="size-3.5" /> : null}
            <span>{resolvedTriggerLabel}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          sessionConfigOptions={sessionConfigOptions}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
}
