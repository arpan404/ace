import {
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
  type ThreadHandoffMode,
} from "@ace/contracts";
import { resolveSelectableModel } from "@ace/shared/model";
import * as Schema from "effect/Schema";
import { memo, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { CheckIcon, ChevronDownIcon, PinIcon, SearchIcon, StarIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator as MenuDivider, MenuTrigger } from "../ui/menu";
import {
  ClaudeAI,
  CursorIcon,
  Gemini,
  GitHubIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
  PiIcon,
} from "../Icons";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../providerModels";
import {
  buildCursorSelectorFamilies,
  pickCursorModelFromTraits,
  resolveCursorSelectorFamily,
  resolveExactCursorModelSelection,
} from "../../cursorModelSelector";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { HandoffMenuButton } from "./HandoffMenu";
import { ProviderInstanceBadge } from "../../providerInstanceBadges";

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
  pi: PiIcon,
  gemini: Gemini,
  opencode: OpenCodeIcon,
};

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
const MODEL_MENU_MAX_HEIGHT = "18rem";
const PROVIDER_PICKER_PREFS_STORAGE_KEY = "ace:provider-model-picker-prefs:v1";
const ProviderModelPickerPrefsSchema = Schema.Struct({
  favoriteModels: Schema.Array(Schema.String),
  pinnedProviders: Schema.Array(Schema.String),
});
type ProviderModelPickerPrefs = typeof ProviderModelPickerPrefsSchema.Type;
const EMPTY_PROVIDER_MODEL_PICKER_PREFS: ProviderModelPickerPrefs = {
  favoriteModels: [],
  pinnedProviders: [],
};
const EMPTY_SERVER_PROVIDER_MODELS: ReadonlyArray<ServerProviderModel> = [];

type ProviderModelOption = Readonly<{ slug: string; name: string }>;
type ProviderInstancePickerOption = Readonly<{
  badgeColor?: string | undefined;
  badgeIcon?: string | undefined;
  enabled: boolean;
  id: string;
  label: string;
}>;

interface ModelPickerRow {
  readonly favoriteKey: string;
  readonly groupLabel?: string;
  readonly label: string;
  readonly searchText: string;
  readonly selectionValue: string;
  readonly slug: string;
}

function isSelectableLiveProvider(provider: ServerProvider | undefined): boolean {
  if (!provider) {
    return false;
  }
  return provider.status === "ready" || provider.versionStatus === "upgrade-required";
}

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

function toProviderBackedModelGroupLabel(providerId: string): string {
  const normalizedId = providerId.trim().toLowerCase();
  switch (normalizedId) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "github-copilot":
    case "githubcopilot":
      return "GitHub Copilot";
    case "lmstudio":
      return "LMStudio";
    case "opencode-go":
    case "opencodego":
      return "OpenCode Go";
    default:
      break;
  }
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

function splitProviderBackedModelOption(option: ProviderModelOption): {
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
    providerLabelFromName || (providerId ? toProviderBackedModelGroupLabel(providerId) : "Other");
  return {
    providerId: providerId || providerLabel.toLowerCase(),
    providerLabel,
    modelLabel: modelLabelFromName || option.name || option.slug,
  };
}

function makeFavoriteModelKey(provider: ProviderKind, slug: string): string {
  return `${provider}:${slug}`;
}

function dedupeStrings(values: ReadonlyArray<string>): Array<string> {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function toggleString(values: ReadonlyArray<string>, value: string): Array<string> {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function buildProviderRows(
  options: ReadonlyArray<(typeof AVAILABLE_PROVIDER_OPTIONS)[number]>,
  pinnedProviders: ReadonlyArray<string>,
): ReadonlyArray<(typeof AVAILABLE_PROVIDER_OPTIONS)[number]> {
  const pinned = new Set(pinnedProviders);
  return [
    ...options.filter((option) => pinned.has(option.value)),
    ...options.filter((option) => !pinned.has(option.value)),
  ];
}

function buildStandardModelRows(
  provider: ProviderKind,
  options: ReadonlyArray<ProviderModelOption>,
): ReadonlyArray<ModelPickerRow> {
  return options.map((option) => {
    const parsed =
      provider === "opencode" || provider === "pi" ? splitProviderBackedModelOption(option) : null;
    const label = parsed?.modelLabel ?? option.name;
    const groupLabel = parsed?.providerLabel;
    return {
      favoriteKey: makeFavoriteModelKey(provider, option.slug),
      ...(groupLabel ? { groupLabel } : {}),
      label,
      searchText: `${label} ${groupLabel ?? ""} ${option.name} ${option.slug}`.toLowerCase(),
      selectionValue: option.slug,
      slug: option.slug,
    };
  });
}

function buildCursorModelRows(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly selectedModel: string;
}): ReadonlyArray<ModelPickerRow> {
  const families = buildCursorSelectorFamilies(input.models);
  const selectedExactModel =
    resolveExactCursorModelSelection({
      models: input.models,
      model: input.selectedModel,
    }) ?? input.selectedModel;
  const selectedFamily = resolveCursorSelectorFamily(input.models, selectedExactModel);

  return families.flatMap((family) => {
    const model =
      family.familySlug === selectedFamily?.familySlug
        ? (input.models.find((candidate) => candidate.slug === selectedExactModel) ?? null)
        : pickCursorModelFromTraits({ family, selections: {} });
    if (!model) {
      return [];
    }
    return [
      {
        favoriteKey: makeFavoriteModelKey("cursor", family.familySlug),
        label: family.familyName,
        searchText: `${family.familyName} ${family.familySlug} ${model.slug}`.toLowerCase(),
        selectionValue: model.slug,
        slug: family.familySlug,
      },
    ];
  });
}

function isRowSelected(
  provider: ProviderKind,
  row: ModelPickerRow,
  selectedModel: string,
): boolean {
  if (provider !== "cursor") {
    return row.selectionValue === selectedModel;
  }
  return row.selectionValue === selectedModel || row.slug === selectedModel;
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  providerInstanceId?: string | undefined;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  providerInstancesByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<ProviderInstancePickerOption>>
  >;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onProviderModelChange: (
    provider: ProviderKind,
    model: string,
    providerInstanceId?: string,
  ) => void;
  /** Icon-only control beside the picker; opens a separate handoff menu. */
  handoff?: {
    providers: ReadonlyArray<ProviderKind>;
    disabled: boolean;
    onSelect: (provider: ProviderKind, mode: ThreadHandoffMode) => void;
  };
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [focusedProvider, setFocusedProvider] = useState<ProviderKind | null>(null);
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useLocalStorage(
    PROVIDER_PICKER_PREFS_STORAGE_KEY,
    EMPTY_PROVIDER_MODEL_PICKER_PREFS,
    ProviderModelPickerPrefsSchema,
  );
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
  const selectedProviderInstance =
    props.providerInstanceId && props.providerInstanceId !== "default"
      ? props.providerInstancesByProvider?.[activeProvider]?.find(
          (instance) => instance.id === props.providerInstanceId,
        )
      : undefined;
  const selectedProviderInstanceLabel = selectedProviderInstance?.label;

  const selectableProviderOptions = useMemo(() => {
    const providers = props.providers;
    const options = !providers
      ? AVAILABLE_PROVIDER_OPTIONS
      : AVAILABLE_PROVIDER_OPTIONS.filter((option) =>
          isSelectableLiveProvider(getProviderSnapshot(providers, option.value)),
        );
    return buildProviderRows(options, prefs.pinnedProviders);
  }, [prefs.pinnedProviders, props.providers]);

  const pickerProvider = useMemo(() => {
    if (props.lockedProvider !== null) {
      return props.lockedProvider;
    }
    if (
      focusedProvider &&
      selectableProviderOptions.some((option) => option.value === focusedProvider)
    ) {
      return focusedProvider;
    }
    if (selectableProviderOptions.some((option) => option.value === props.provider)) {
      return props.provider;
    }
    return selectableProviderOptions[0]?.value ?? props.provider;
  }, [focusedProvider, props.lockedProvider, props.provider, selectableProviderOptions]);

  const pickerProviderOption =
    AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === pickerProvider) ??
    AVAILABLE_PROVIDER_OPTIONS[0]!;
  const PickerProviderIcon = PROVIDER_ICON_BY_PROVIDER[pickerProvider];
  const pickerProviderSnapshot = props.providers
    ? getProviderSnapshot(props.providers, pickerProvider)
    : undefined;
  const pickerProviderModels = pickerProviderSnapshot?.models ?? EMPTY_SERVER_PROVIDER_MODELS;
  const pickerModelOptions = props.modelOptionsByProvider[pickerProvider];
  const pickerRows = useMemo(
    () =>
      pickerProvider === "cursor" && pickerProviderModels.length > 0
        ? buildCursorModelRows({ models: pickerProviderModels, selectedModel: props.model })
        : buildStandardModelRows(pickerProvider, pickerModelOptions),
    [pickerModelOptions, pickerProvider, pickerProviderModels, props.model],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = useMemo(
    () =>
      normalizedQuery.length === 0
        ? pickerRows
        : pickerRows.filter((row) => row.searchText.includes(normalizedQuery)),
    [normalizedQuery, pickerRows],
  );
  const favoriteModelSet = useMemo(() => new Set(prefs.favoriteModels), [prefs.favoriteModels]);
  const favoriteRows = visibleRows.filter((row) => favoriteModelSet.has(row.favoriteKey));
  const allPinnedProviderSet = useMemo(
    () => new Set(prefs.pinnedProviders),
    [prefs.pinnedProviders],
  );

  const handleModelChange = (
    provider: ProviderKind,
    value: string,
    options: ReadonlyArray<{ slug: string; name: string }> = props.modelOptionsByProvider[provider],
    closeMenu = true,
    providerInstanceId = props.provider === provider ? props.providerInstanceId : undefined,
  ) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel =
      provider === "cursor" ? value : resolveSelectableModel(provider, value, options);
    if (!resolvedModel) return;
    if (providerInstanceId === undefined) {
      props.onProviderModelChange(provider, resolvedModel);
    } else {
      props.onProviderModelChange(provider, resolvedModel, providerInstanceId);
    }
    if (closeMenu) {
      setIsMenuOpen(false);
    }
  };
  const handleProviderInstanceChange = (provider: ProviderKind, providerInstanceId: string) => {
    if (props.disabled) return;
    const options = props.modelOptionsByProvider[provider];
    const model = props.provider === provider ? props.model : options[0]?.slug;
    if (!model) return;
    const resolvedModel =
      provider === "cursor" ? model : (resolveSelectableModel(provider, model, options) ?? model);
    props.onProviderModelChange(provider, resolvedModel, providerInstanceId);
    setIsMenuOpen(false);
  };
  const togglePinnedProvider = (provider: ProviderKind) => {
    setPrefs((previous) => ({
      favoriteModels: dedupeStrings(previous.favoriteModels),
      pinnedProviders: toggleString(dedupeStrings(previous.pinnedProviders), provider),
    }));
  };
  const toggleFavoriteModel = (favoriteKey: string) => {
    setPrefs((previous) => ({
      favoriteModels: toggleString(dedupeStrings(previous.favoriteModels), favoriteKey),
      pinnedProviders: dedupeStrings(previous.pinnedProviders),
    }));
  };

  const renderAccountPicker = () => {
    const instances = props.providerInstancesByProvider?.[pickerProvider]?.filter(
      (instance) => instance.enabled,
    );
    if (!instances?.length) {
      return null;
    }
    const selectedInstance =
      props.provider === pickerProvider ? (props.providerInstanceId ?? "default") : "default";
    return (
      <div className="border-b border-border/60 px-2.5 py-1.5">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
          Account
        </div>
        <div className="flex min-w-0 flex-wrap gap-1">
          {[{ id: "default", label: "Default" }, ...instances].map(
            (instance: { id: string; label: string } & Partial<ProviderInstancePickerOption>) => {
              const selected = selectedInstance === instance.id;
              return (
                <button
                  key={`${pickerProvider}:account:${instance.id}`}
                  type="button"
                  className={cn(
                    "inline-flex h-7 max-w-full items-center gap-1.5 rounded-[var(--chip-radius)] border px-2 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "border-primary/35 bg-primary/10 text-foreground"
                      : "border-border/60 bg-background/40 text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  onPointerDownCapture={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleProviderInstanceChange(pickerProvider, instance.id);
                  }}
                  onClickCapture={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleProviderInstanceChange(pickerProvider, instance.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    handleProviderInstanceChange(pickerProvider, instance.id);
                  }}
                >
                  {selected ? <CheckIcon aria-hidden="true" className="size-3" /> : null}
                  {instance.id !== "default" ? (
                    <ProviderInstanceBadge
                      color={instance.badgeColor}
                      icon={instance.badgeIcon}
                      className="size-4 shrink-0"
                    />
                  ) : null}
                  <span className="truncate">{instance.label}</span>
                </button>
              );
            },
          )}
        </div>
      </div>
    );
  };

  const renderModelRow = (row: ModelPickerRow, section: "favorite" | "all") => {
    const selected =
      props.provider === pickerProvider && isRowSelected(pickerProvider, row, props.model);
    const favorited = favoriteModelSet.has(row.favoriteKey);
    return (
      <div
        key={`${section}:${row.favoriteKey}`}
        className={cn(
          "grid grid-cols-[1fr_auto] items-center gap-1 rounded-[var(--chip-radius)]",
          selected ? "bg-accent/90 text-accent-foreground" : "hover:bg-accent/70",
        )}
      >
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selected}
          className="grid min-h-7 min-w-0 grid-cols-[0.875rem_1fr] items-center gap-1.5 rounded-[var(--chip-radius)] px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => handleModelChange(pickerProvider, row.selectionValue)}
        >
          <span className="flex size-3.5 items-center justify-center">
            {selected ? <CheckIcon aria-hidden="true" className="size-3" /> : null}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{row.label}</span>
            {row.groupLabel ? (
              <span className="block truncate text-[10px] text-muted-foreground">
                {row.groupLabel}
              </span>
            ) : null}
          </span>
        </button>
        <button
          type="button"
          aria-label={`${favorited ? "Remove favorite" : "Favorite"} ${row.label}`}
          title={favorited ? "Remove favorite" : "Favorite model"}
          className={cn(
            "me-0.5 inline-flex size-6 items-center justify-center rounded-[var(--chip-radius)] text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            favorited ? "text-warning-foreground" : undefined,
          )}
          onClick={(event) => {
            event.stopPropagation();
            toggleFavoriteModel(row.favoriteKey);
          }}
        >
          <StarIcon
            aria-hidden="true"
            className={cn("size-3", favorited ? "fill-current" : undefined)}
          />
        </button>
      </div>
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
        if (open) {
          setFocusedProvider(activeProvider);
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
              props.compact ? "max-w-42 shrink-0" : "max-w-56 shrink sm:max-w-72 sm:px-2.5",
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
          <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
            <ProviderIcon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                providerIconClassName(activeProvider, "text-muted-foreground"),
                props.activeProviderIconClassName,
              )}
            />
            {selectedProviderInstance ? (
              <ProviderInstanceBadge
                color={selectedProviderInstance.badgeColor}
                icon={selectedProviderInstance.badgeIcon}
                className="absolute -bottom-1 -right-1 size-3 border-[1.5px]"
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {selectedProviderInstanceLabel
              ? `${selectedModelLabel} / ${selectedProviderInstanceLabel}`
              : selectedModelLabel}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="w-[min(calc(100vw-1rem),30rem)]"
        listMaxHeight={MODEL_MENU_MAX_HEIGHT}
      >
        {props.lockedProvider === null && selectableProviderOptions.length === 0 ? (
          <MenuItem disabled>No providers available.</MenuItem>
        ) : (
          <div
            className={cn(
              "grid min-h-52 w-full overflow-hidden",
              props.lockedProvider === null ? "grid-cols-[2.75rem_minmax(0,1fr)]" : "grid-cols-1",
            )}
          >
            {props.lockedProvider === null ? (
              <div className="border-r border-border/60 bg-muted/20 p-1">
                <div className="space-y-0.5">
                  {selectableProviderOptions.map((option) => {
                    const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
                    const selected = pickerProvider === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-label={option.label}
                        title={option.label}
                        className={cn(
                          "flex size-8 items-center justify-center rounded-[var(--chip-radius)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                          selected
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                        )}
                        onClick={() => setFocusedProvider(option.value)}
                      >
                        <OptionIcon
                          aria-hidden="true"
                          className={cn(
                            "size-4 shrink-0",
                            providerIconClassName(option.value, "text-muted-foreground"),
                          )}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="flex min-w-0 flex-col overflow-hidden">
              <div className="border-b border-border/60 px-2.5 py-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <PickerProviderIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 shrink-0",
                      providerIconClassName(pickerProvider, "text-muted-foreground"),
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{pickerProviderOption.label}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {pickerRows.length} {pickerRows.length === 1 ? "model" : "models"}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`${allPinnedProviderSet.has(pickerProvider) ? "Unpin" : "Pin"} ${pickerProviderOption.label}`}
                    title={
                      allPinnedProviderSet.has(pickerProvider) ? "Unpin provider" : "Pin provider"
                    }
                    className="inline-flex size-6 items-center justify-center rounded-[var(--chip-radius)] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => togglePinnedProvider(pickerProvider)}
                  >
                    <PinIcon
                      aria-hidden="true"
                      className={cn(
                        "size-3",
                        allPinnedProviderSet.has(pickerProvider)
                          ? "fill-current text-foreground"
                          : undefined,
                      )}
                    />
                  </button>
                </div>
              </div>
              {renderAccountPicker()}
              <div className="border-b border-border/60 px-2.5 py-1.5">
                <div className="flex h-7 items-center gap-1.5 rounded-[var(--chip-radius)] border border-border/60 bg-background/50 px-2">
                  <SearchIcon
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground"
                  />
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
                    className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {favoriteRows.length > 0 ? (
                  <>
                    <div className="px-1.5 pb-0.5 pt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                      Favorites
                    </div>
                    <div className="space-y-0.5">
                      {favoriteRows.map((row) => renderModelRow(row, "favorite"))}
                    </div>
                    <MenuDivider />
                  </>
                ) : null}

                <div className="px-1.5 pb-0.5 pt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                  Models
                </div>
                {visibleRows.length === 0 ? (
                  <MenuItem disabled>
                    {query.trim().length > 0
                      ? "No models match your search."
                      : "No models available."}
                  </MenuItem>
                ) : (
                  <div className="space-y-0.5">
                    {visibleRows.map((row) => renderModelRow(row, "all"))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </MenuPopup>
    </Menu>
  );

  if (!props.handoff) {
    return modelMenu;
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {modelMenu}
      <HandoffMenuButton
        {...(props.disabled ? { disabled: true } : {})}
        entriesDisabled={props.handoff.disabled}
        providers={props.handoff.providers}
        showLabel={false}
        triggerClassName={cn("shrink-0 rounded-md", props.compact ? "size-7 sm:size-8" : "size-8")}
        triggerVariant={props.triggerVariant ?? "ghost"}
        onSelect={(provider, mode) => {
          props.handoff?.onSelect(provider, mode);
        }}
      />
    </div>
  );
});
