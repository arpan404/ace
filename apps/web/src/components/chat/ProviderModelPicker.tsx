import { type ProviderKind, type ServerProvider, type ThreadHandoffMode } from "@ace/contracts";
import { resolveSelectableModel } from "@ace/shared/model";
import { memo, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
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
const OPENCODE_MODEL_MENU_STABLE_HEIGHT_STYLE = {
  minHeight: `min(var(--available-height), ${MODEL_MENU_MAX_HEIGHT})`,
};
type ProviderModelOption = Readonly<{ slug: string; name: string }>;

function toOpenCodeProviderLabel(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "ai") {
        return "AI";
      }
      if (lower.length <= 2) {
        return lower.toUpperCase();
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function splitOpenCodeModelOption(option: ProviderModelOption): {
  providerId: string;
  providerLabel: string;
  modelLabel: string;
} {
  const name = option.name.trim();
  const separatorIndex = name.indexOf(":");
  const providerLabelFromName = separatorIndex > 0 ? name.slice(0, separatorIndex).trim() : "";
  const modelLabelFromName = separatorIndex > 0 ? name.slice(separatorIndex + 1).trim() : name;
  const slashIndex = option.slug.indexOf("/");
  const providerId = slashIndex > 0 ? option.slug.slice(0, slashIndex).trim() : "";
  const providerLabel =
    providerLabelFromName || (providerId ? toOpenCodeProviderLabel(providerId) : "Other");
  return {
    providerId: providerId || providerLabel.toLowerCase(),
    providerLabel,
    modelLabel: modelLabelFromName || option.name || option.slug,
  };
}

const OpenCodeModelMenuContent = memo(function OpenCodeModelMenuContent(props: {
  options: ReadonlyArray<ProviderModelOption>;
  selectedModel: string;
  onModelChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const groupedOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const groups = new Map<
      string,
      {
        providerLabel: string;
        options: Array<ProviderModelOption & { modelLabel: string }>;
      }
    >();

    for (const option of props.options) {
      const parsed = splitOpenCodeModelOption(option);
      const searchText =
        `${parsed.providerLabel} ${parsed.modelLabel} ${option.slug} ${option.name}`.toLowerCase();
      if (normalizedQuery.length > 0 && !searchText.includes(normalizedQuery)) {
        continue;
      }
      const group = groups.get(parsed.providerId);
      if (group) {
        group.options.push({ ...option, modelLabel: parsed.modelLabel });
        continue;
      }
      groups.set(parsed.providerId, {
        providerLabel: parsed.providerLabel,
        options: [{ ...option, modelLabel: parsed.modelLabel }],
      });
    }

    return [...groups.entries()].map(([providerId, group]) => ({
      providerId,
      providerLabel: group.providerLabel,
      options: group.options,
    }));
  }, [props.options, query]);

  return (
    <>
      <div className="px-2 pb-1 pt-1">
        <div className="flex items-center gap-1.5 border-b border-border/40 pb-1">
          <SearchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />
          <input
            type="search"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") {
                event.stopPropagation();
              }
            }}
            placeholder="Search models"
            className="h-7 w-full border-0 bg-transparent px-0 text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      {groupedOptions.length === 0 ? (
        <MenuItem disabled>
          {query.trim().length > 0 ? "No models match your search." : "No models available."}
        </MenuItem>
      ) : (
        groupedOptions.map((group) => (
          <MenuGroup key={`opencode-group:${group.providerId}`}>
            <MenuGroupLabel className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              {group.providerLabel}
            </MenuGroupLabel>
            <MenuRadioGroup value={props.selectedModel} onValueChange={props.onModelChange}>
              {group.options.map((modelOption) => (
                <MenuRadioItem key={`opencode-model:${modelOption.slug}`} value={modelOption.slug}>
                  {modelOption.modelLabel}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ))
      )}
    </>
  );
});

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
    if (provider === "opencode") {
      return (
        <OpenCodeModelMenuContent
          options={options}
          selectedModel={value}
          onModelChange={(nextValue) => handleModelChange(provider, nextValue, options)}
        />
      );
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
      <MenuPopup
        align="start"
        listMaxHeight={MODEL_MENU_MAX_HEIGHT}
        {...(props.lockedProvider === "opencode"
          ? { style: OPENCODE_MODEL_MENU_STABLE_HEIGHT_STYLE }
          : {})}
      >
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
                const messageLower = liveProvider.message?.toLowerCase() ?? "";
                const unavailableLabel = !liveProvider.enabled
                  ? "Disabled"
                  : messageLower.startsWith("checking ")
                    ? "Checking"
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
                  <MenuSubPopup
                    listMaxHeight={MODEL_MENU_MAX_HEIGHT}
                    sideOffset={4}
                    {...(option.value === "opencode"
                      ? { style: OPENCODE_MODEL_MENU_STABLE_HEIGHT_STYLE }
                      : {})}
                  >
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
