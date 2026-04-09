import { type ProviderKind, type ServerProvider, type ThreadHandoffMode } from "@ace/contracts";
import { resolveSelectableModel } from "@ace/shared/model";
import { memo, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ClaudeAI, CursorIcon, Gemini, GitHubIcon, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../providerModels";
import {
  buildCursorSelectorFamilies,
  pickCursorModelFromTraits,
  resolveCursorSelectorFamily,
  resolveExactCursorModelSelection,
} from "../../cursorModelSelector";
import { HandoffMenuButton } from "./HandoffMenu";

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  githubCopilot: GitHubIcon,
  cursor: CursorIcon,
  gemini: Gemini,
  opencode: OpenCodeIcon,
};

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);
const MODEL_MENU_MAX_HEIGHT = "24rem";

const CursorModelMenuContent = memo(function CursorModelMenuContent(props: {
  models: ReadonlyArray<NonNullable<ServerProvider["models"]>[number]>;
  selectedModel: string;
  onModelChange: (value: string) => void;
}) {
  const families = useMemo(() => buildCursorSelectorFamilies(props.models), [props.models]);
  const selectedExactModel = useMemo(
    () =>
      resolveExactCursorModelSelection({
        models: props.models,
        model: props.selectedModel,
      }) ?? props.selectedModel,
    [props.models, props.selectedModel],
  );
  const selectedFamily =
    resolveCursorSelectorFamily(props.models, selectedExactModel) ?? families[0] ?? null;

  if (families.length === 0 || !selectedFamily) {
    return <MenuItem disabled>No Cursor models available.</MenuItem>;
  }

  const applyFamilySelection = (familySlug: string) => {
    const family = families.find((candidate) => candidate.familySlug === familySlug);
    if (!family) {
      return;
    }
    const nextModel =
      familySlug === selectedFamily.familySlug
        ? (props.models.find((model) => model.slug === selectedExactModel) ?? null)
        : pickCursorModelFromTraits({ family, selections: {} });
    if (!nextModel) {
      return;
    }
    props.onModelChange(nextModel.slug);
  };

  return (
    <MenuGroup>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Model Family</div>
      <MenuRadioGroup
        value={selectedFamily.familySlug}
        onValueChange={(value) => applyFamilySelection(value)}
      >
        {families.map((family) => (
          <MenuRadioItem key={`cursor-family:${family.familySlug}`} value={family.familySlug}>
            {family.familyName}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
});

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  if (provider === "claudeAgent") {
    return "text-warning-foreground";
  }
  if (provider === "githubCopilot") {
    return "text-foreground";
  }
  return fallbackClassName;
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
  /** Icon-only control beside the picker; opens a separate handoff menu. */
  handoff?: {
    providers: ReadonlyArray<ProviderKind>;
    disabled: boolean;
    onSelect: (provider: ProviderKind, mode: ThreadHandoffMode) => void;
  };
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const cursorModels = useMemo(
    () => (props.providers ? (getProviderSnapshot(props.providers, "cursor")?.models ?? []) : []),
    [props.providers],
  );
  const selectedCursorModel = useMemo(
    () =>
      activeProvider === "cursor"
        ? resolveExactCursorModelSelection({
            models: cursorModels,
            model: props.model,
          })
        : null,
    [activeProvider, cursorModels, props.model],
  );
  const selectedCursorFamily = useMemo(
    () =>
      activeProvider === "cursor" && selectedCursorModel
        ? resolveCursorSelectorFamily(cursorModels, selectedCursorModel)
        : null,
    [activeProvider, cursorModels, selectedCursorModel],
  );
  const selectedModelLabel =
    activeProvider === "cursor"
      ? (selectedCursorFamily?.familyName ?? props.model)
      : (selectedProviderOptions.find((option) => option.slug === props.model)?.name ??
        props.model);
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const handleModelChange = (
    provider: ProviderKind,
    value: string,
    options: ReadonlyArray<{ slug: string; name: string }> = props.modelOptionsByProvider[provider],
    closeMenu = true,
  ) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(provider, value, options);
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    if (closeMenu) {
      setIsMenuOpen(false);
    }
  };

  const handoffConfig = props.handoff;
  const renderCursorModelMenu = (provider: "cursor") =>
    cursorModels.length > 0 ? (
      <CursorModelMenuContent
        models={cursorModels}
        selectedModel={
          props.provider === provider ? props.model : provider === activeProvider ? props.model : ""
        }
        onModelChange={(value) => handleModelChange(provider, value)}
      />
    ) : (
      <MenuGroup>
        <MenuRadioGroup
          value={props.provider === provider ? props.model : ""}
          onValueChange={(value) => handleModelChange(provider, value)}
        >
          {props.modelOptionsByProvider[provider].map((modelOption) => (
            <MenuRadioItem key={`${provider}:${modelOption.slug}`} value={modelOption.slug}>
              {modelOption.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    );
  const renderStandardModelMenu = (provider: ProviderKind, value: string) => {
    const options = props.modelOptionsByProvider[provider];
    if (options.length === 0) {
      return <MenuItem disabled>No models available.</MenuItem>;
    }
    return (
      <MenuGroup>
        <MenuRadioGroup
          value={value}
          onValueChange={(nextValue) => handleModelChange(provider, nextValue)}
        >
          {options.map((modelOption) => (
            <MenuRadioItem
              key={`${provider}:${modelOption.slug}`}
              value={modelOption.slug}
              onClick={() => setIsMenuOpen(false)}
            >
              {modelOption.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    );
  };

  const modelMenu = (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground transition-colors duration-150 hover:text-foreground [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-2.5",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
            props.compact ? "max-w-36 sm:pl-1" : undefined,
          )}
        >
          <ProviderIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0",
              providerIconClassName(activeProvider, "text-muted-foreground"),
              props.activeProviderIconClassName,
            )}
          />
          <span className="min-w-0 flex-1 truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" listMaxHeight={MODEL_MENU_MAX_HEIGHT}>
        {props.lockedProvider !== null ? (
          props.lockedProvider === "cursor" ? (
            renderCursorModelMenu("cursor")
          ) : (
            renderStandardModelMenu(props.lockedProvider, props.model)
          )
        ) : (
          <>
            {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              const liveProvider = props.providers
                ? getProviderSnapshot(props.providers, option.value)
                : undefined;
              if (liveProvider && liveProvider.status !== "ready") {
                const unavailableLabel = !liveProvider.enabled
                  ? "Disabled"
                  : !liveProvider.installed
                    ? "Not installed"
                    : "Unavailable";
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 opacity-80",
                        providerIconClassName(option.value, "text-muted-foreground"),
                      )}
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
                      {unavailableLabel}
                    </span>
                  </MenuItem>
                );
              }
              return (
                <MenuSub key={option.value}>
                  <MenuSubTrigger>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        providerIconClassName(option.value, "text-muted-foreground"),
                      )}
                    />
                    {option.label}
                  </MenuSubTrigger>
                  <MenuSubPopup listMaxHeight={MODEL_MENU_MAX_HEIGHT} sideOffset={4}>
                    {option.value === "cursor"
                      ? renderCursorModelMenu("cursor")
                      : renderStandardModelMenu(
                          option.value,
                          props.provider === option.value ? props.model : "",
                        )}
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuDivider />}
            {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              return (
                <MenuItem key={option.value} disabled>
                  <OptionIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground opacity-80"
                  />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
          </>
        )}
      </MenuPopup>
    </Menu>
  );

  if (!handoffConfig) {
    return modelMenu;
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {modelMenu}
      <HandoffMenuButton
        {...(props.disabled ? { disabled: true } : {})}
        entriesDisabled={handoffConfig.disabled}
        providers={handoffConfig.providers}
        showLabel={false}
        triggerClassName={cn("shrink-0 rounded-md", props.compact ? "size-7 sm:size-8" : "size-8")}
        triggerVariant={props.triggerVariant ?? "ghost"}
        onSelect={(provider, mode) => {
          handoffConfig.onSelect(provider, mode);
        }}
      />
    </div>
  );
});
