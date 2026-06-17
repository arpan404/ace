import {
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
  type ThreadHandoffMode,
} from "@ace/contracts";
import { resolveSelectableModel } from "@ace/shared/model";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import {
  CheckIcon,
  ChevronDownIcon,
  PinIcon,
  SearchIcon,
  Settings2Icon,
  StarIcon,
} from "lucide-react";
import { IconBoltFilled } from "@tabler/icons-react";
import { Button } from "../ui/button";
import { buttonVariants } from "../ui/buttonVariants";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  APP_COMPOSER_CONTROL_CLASS_NAME,
  APP_SETTINGS_PICKER_TRIGGER_CLASS_NAME,
} from "~/lib/appChrome";
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
import { AVAILABLE_PROVIDER_OPTIONS } from "./providerModelPickerOptions";
import { PROVIDER_ICON_BY_PROVIDER, providerIconClassName } from "./providerIcons";
import { ProviderInstanceBadge } from "../../providerInstanceBadges";
const MODEL_MENU_MAX_HEIGHT = "21rem";
const PROVIDER_PICKER_PREFS_STORAGE_KEY = "ace:provider-model-picker-prefs:v1";
const FAVORITES_PROVIDER_ENTRY_KEY = "__favorites__";
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
type ProviderPickerEntry = Readonly<{
  accountLabel: string;
  badgeColor?: string | undefined;
  badgeIcon?: string | undefined;
  instanceId?: string | undefined;
  label: string;
  provider: ProviderKind;
}>;

interface ModelPickerRow {
  readonly favoriteKey: string;
  readonly groupLabel?: string;
  readonly label: string;
  readonly provider: ProviderKind;
  readonly providerInstanceId?: string | undefined;
  readonly searchText: string;
  readonly selectionValue: string;
  readonly slug: string;
}

interface ProviderModelPickerProps {
  provider: ProviderKind;
  providerInstanceId?: string | undefined;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  modelSelectionByProvider?: Record<string, ModelSelection | undefined>;
  providerInstancesByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<ProviderInstancePickerOption>>
  >;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  triggerSurface?: "composer" | "settings";
  renderTraitsMenuContent?: ((model: string) => ReactNode) | undefined;
  traitsMenuContent?: ReactNode;
  triggerTraitSummary?: string | undefined;
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
}

function isSelectableLiveProvider(provider: ServerProvider | undefined): boolean {
  if (!provider) {
    return false;
  }
  return provider.status === "ready" || provider.versionStatus === "upgrade-required";
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
    .reduce<string[]>((parts, part) => {
      if (part.length === 0) {
        return parts;
      }
      const lower = part.toLowerCase();
      if (lower === "ai") {
        parts.push("AI");
        return parts;
      }
      if (lower.length <= 2) {
        parts.push(lower.toUpperCase());
        return parts;
      }
      parts.push(lower.charAt(0).toUpperCase() + lower.slice(1));
      return parts;
    }, [])
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

function makeProviderEntryKey(provider: ProviderKind, instanceId: string | undefined): string {
  return `${provider}:${instanceId ?? "default"}`;
}

function makeFavoriteModelKey(
  provider: ProviderKind,
  instanceId: string | undefined,
  slug: string,
): string {
  return `${makeProviderEntryKey(provider, instanceId)}:${slug}`;
}

function dedupeStrings(values: ReadonlyArray<string>): Array<string> {
  const normalizedValues = new Set<string>();
  for (const value of values) {
    const normalizedValue = value.trim();
    if (normalizedValue.length > 0) {
      normalizedValues.add(normalizedValue);
    }
  }
  return [...normalizedValues];
}

function toggleString(values: ReadonlyArray<string>, value: string): Array<string> {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function isProviderEntryPinned(
  pinnedProviders: ReadonlyArray<string>,
  entry: ProviderPickerEntry,
): boolean {
  const pinned = new Set(pinnedProviders);
  const entryKey = makeProviderEntryKey(entry.provider, entry.instanceId);
  return pinned.has(entryKey) || (entry.instanceId === undefined && pinned.has(entry.provider));
}

function buildProviderEntryRows(
  entries: ReadonlyArray<ProviderPickerEntry>,
  pinnedProviders: ReadonlyArray<string>,
): ReadonlyArray<ProviderPickerEntry> {
  return [
    ...entries.filter((entry) => isProviderEntryPinned(pinnedProviders, entry)),
    ...entries.filter((entry) => !isProviderEntryPinned(pinnedProviders, entry)),
  ];
}

function normalizeProviderInstanceId(providerInstanceId: string | null | undefined): string {
  return providerInstanceId && providerInstanceId !== "default" ? providerInstanceId : "default";
}

function buildProviderPickerEntries(input: {
  readonly defaultProviderSelectableByProvider?: Partial<Record<ProviderKind, boolean>> | undefined;
  readonly options: ReadonlyArray<(typeof AVAILABLE_PROVIDER_OPTIONS)[number]>;
  readonly providerInstancesByProvider:
    | Partial<Record<ProviderKind, ReadonlyArray<ProviderInstancePickerOption>>>
    | undefined;
}): ReadonlyArray<ProviderPickerEntry> {
  return input.options.flatMap((option) => {
    const includeDefault = input.defaultProviderSelectableByProvider?.[option.value] ?? true;
    const instances =
      input.providerInstancesByProvider?.[option.value]?.filter((instance) => instance.enabled) ??
      [];
    const entries: Array<ProviderPickerEntry> = includeDefault
      ? [
          {
            provider: option.value,
            accountLabel: "Default",
            label: option.label,
          },
        ]
      : [];
    for (const instance of instances) {
      entries.push({
        provider: option.value,
        instanceId: instance.id,
        accountLabel: instance.label,
        label: `${option.label} ${instance.label}`,
        badgeColor: instance.badgeColor,
        badgeIcon: instance.badgeIcon,
      });
    }
    return entries;
  });
}

function buildStandardModelRows(
  provider: ProviderKind,
  providerInstanceId: string | undefined,
  options: ReadonlyArray<ProviderModelOption>,
): ReadonlyArray<ModelPickerRow> {
  return options.map((option) => {
    const parsed =
      provider === "opencode" || provider === "pi" ? splitProviderBackedModelOption(option) : null;
    const label = parsed?.modelLabel ?? option.name;
    const groupLabel = parsed?.providerLabel;
    return {
      favoriteKey: makeFavoriteModelKey(provider, providerInstanceId, option.slug),
      ...(groupLabel ? { groupLabel } : {}),
      label,
      provider,
      ...(providerInstanceId ? { providerInstanceId } : {}),
      searchText: `${label} ${groupLabel ?? ""} ${option.name} ${option.slug}`.toLowerCase(),
      selectionValue: option.slug,
      slug: option.slug,
    };
  });
}

function modelOptionsFromServerModels(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ProviderModelOption> {
  return models.map((model) => ({
    slug: model.slug,
    name: model.name,
  }));
}

function buildCursorModelRows(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly providerInstanceId: string | undefined;
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
        favoriteKey: makeFavoriteModelKey("cursor", input.providerInstanceId, family.familySlug),
        label: family.familyName,
        provider: "cursor",
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
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

function ProviderModelPickerModelRow(props: {
  readonly favorited: boolean;
  readonly row: ModelPickerRow;
  readonly section: "current" | "favorite" | "all";
  readonly selected: boolean;
  readonly showProviderIcon?: boolean;
  readonly traitsMenuContent?: ReactNode;
  readonly onFavoriteModelToggle: (favoriteKey: string) => void;
  readonly onModelSelect: (row: ModelPickerRow) => void;
}) {
  const selectRow = () => {
    if (!props.selected) {
      props.onModelSelect(props.row);
    }
  };

  const RowProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.row.provider];
  return (
    <div
      key={`${props.section}:${props.row.favoriteKey}`}
      className={cn(
        "group/model-row relative grid grid-cols-[1fr_auto] items-center gap-1 rounded-[0.7rem] border border-transparent transition-colors duration-150",
        props.selected
          ? "border-border/45 bg-foreground/[0.065] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/.055)] dark:bg-white/[0.075]"
          : "text-foreground/84 hover:border-border/38 hover:bg-foreground/[0.045] hover:text-foreground dark:hover:bg-white/[0.065]",
      )}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={props.selected}
        className={cn(
          "grid min-h-8 min-w-0 items-center gap-2 rounded-[0.7rem] px-2.5 py-1 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
          props.showProviderIcon ? "grid-cols-[1rem_1rem_1fr]" : "grid-cols-[1rem_1fr]",
        )}
        onClick={() => props.onModelSelect(props.row)}
      >
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-[0.35rem] border text-[9px] transition-colors duration-150",
            props.selected
              ? "border-primary/35 bg-primary/12 text-primary"
              : "border-border/45 bg-foreground/[0.035] text-muted-foreground/45",
          )}
        >
          {props.selected ? (
            <CheckIcon aria-hidden="true" className="size-2.5" strokeWidth={2.5} />
          ) : null}
        </span>
        {props.showProviderIcon ? (
          <span className="inline-flex size-4 items-center justify-center text-muted-foreground/68">
            <RowProviderIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0",
                providerIconClassName(props.row.provider, "text-muted-foreground"),
              )}
            />
          </span>
        ) : null}
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate leading-snug",
              props.selected ? "font-medium text-foreground" : "font-normal",
            )}
          >
            {props.row.label}
          </span>
          {props.row.groupLabel ? (
            <span className="mt-px block truncate text-[10.5px] leading-tight text-muted-foreground/58">
              {props.row.groupLabel}
            </span>
          ) : null}
        </span>
      </button>
      <div className="me-1 flex items-center gap-0.5">
        {props.traitsMenuContent ? (
          <MenuSub>
            <MenuSubTrigger
              aria-label={
                props.section === "current"
                  ? `Current model settings for ${props.row.label}`
                  : `Model settings for ${props.row.label}`
              }
              className="inline-flex size-6 min-h-0 items-center justify-center gap-0 rounded-md p-0 text-muted-foreground/62 outline-none transition-colors duration-150 hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/[0.08] [&>svg:last-child]:hidden"
              onClick={selectRow}
            >
              <Settings2Icon aria-hidden="true" className="size-3.5" />
            </MenuSubTrigger>
            <MenuSubPopup
              align="start"
              className="w-[13.5rem] rounded-[1rem] border-border/45 bg-[color:color-mix(in_oklch,var(--popover)_97%,var(--background)_3%)] shadow-[0_18px_54px_-36px_rgb(0_0_0/.7)] dark:bg-[color:color-mix(in_oklch,var(--popover)_94%,var(--background)_6%)]"
              listClassName="p-3"
              listMaxHeight="18rem"
            >
              <div
                onKeyDownCapture={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    selectRow();
                  }
                }}
                onPointerDownCapture={selectRow}
              >
                {props.traitsMenuContent}
              </div>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`${props.favorited ? "Remove favorite" : "Favorite"} ${props.row.label}`}
                className={cn(
                  "inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/45 outline-none transition-colors duration-150 hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  props.favorited
                    ? "text-amber-500 opacity-100"
                    : "opacity-0 group-hover/model-row:opacity-100",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onFavoriteModelToggle(props.row.favoriteKey);
                }}
              />
            }
          >
            <StarIcon
              aria-hidden="true"
              className={cn("size-3", props.favorited ? "fill-current" : undefined)}
            />
          </TooltipTrigger>
          <TooltipPopup side="left">
            {props.favorited ? "Remove favorite" : "Favorite model"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function ProviderModelPickerRenderedRow(props: {
  readonly activeProvider: ProviderKind;
  readonly favoriteModelSet: ReadonlySet<string>;
  readonly providerInstanceId?: string | undefined;
  readonly row: ModelPickerRow;
  readonly section: "current" | "favorite" | "all";
  readonly selectedModel: string;
  readonly showProviderIcon: boolean;
  readonly traitsMenuContent?: ReactNode;
  readonly onFavoriteModelToggle: (favoriteKey: string) => void;
  readonly onModelSelect: (row: ModelPickerRow) => void;
}) {
  const selected =
    props.activeProvider === props.row.provider &&
    normalizeProviderInstanceId(props.providerInstanceId) ===
      normalizeProviderInstanceId(props.row.providerInstanceId) &&
    isRowSelected(props.row.provider, props.row, props.selectedModel);
  return (
    <ProviderModelPickerModelRow
      favorited={props.favoriteModelSet.has(props.row.favoriteKey)}
      row={props.row}
      section={props.section}
      selected={selected}
      showProviderIcon={props.showProviderIcon}
      traitsMenuContent={props.traitsMenuContent}
      onFavoriteModelToggle={props.onFavoriteModelToggle}
      onModelSelect={props.onModelSelect}
    />
  );
}

function ProviderModelPickerMenu(props: {
  readonly activeProvider: ProviderKind;
  readonly activeProviderEntryKey: string;
  readonly activeProviderIconClassName?: string | undefined;
  readonly compact?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly displayedProviderEntries: ReadonlyArray<ProviderPickerEntry>;
  readonly favoriteModelSet: ReadonlySet<string>;
  readonly allFavoriteRows: ReadonlyArray<ModelPickerRow>;
  readonly favoriteRows: ReadonlyArray<ModelPickerRow>;
  readonly currentModelRow: ModelPickerRow | null;
  readonly isMenuOpen: boolean;
  readonly modelRows: ReadonlyArray<ModelPickerRow>;
  readonly pickerProvider: ProviderKind;
  readonly pickerProviderEntry: ProviderPickerEntry;
  readonly pickerProviderEntryKey: string;
  readonly pickerProviderEntryPinned: boolean;
  readonly pickerProviderInstanceId?: string | undefined;
  readonly pickerProviderOption: (typeof AVAILABLE_PROVIDER_OPTIONS)[number];
  readonly pickerRows: ReadonlyArray<ModelPickerRow>;
  readonly providerInstanceId?: string | undefined;
  readonly query: string;
  readonly selectedModel: string;
  readonly selectedModelLabel: string;
  readonly selectedProviderInstance?: ProviderInstancePickerOption | undefined;
  readonly showProviderRail: boolean;
  readonly showFavoritesView: boolean;
  readonly triggerClassName?: string | undefined;
  readonly triggerSurface?: "composer" | "settings" | undefined;
  readonly triggerTraitSummary?: string | undefined;
  readonly triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  readonly renderTraitsMenuContent?: ((model: string) => ReactNode) | undefined;
  readonly traitsMenuContent?: ReactNode;
  readonly onFavoriteModelToggle: (favoriteKey: string) => void;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly onModelSelect: (row: ModelPickerRow) => void;
  readonly onProviderEntryFocus: (
    entry: ProviderPickerEntry | typeof FAVORITES_PROVIDER_ENTRY_KEY,
  ) => void;
  readonly onProviderPinToggle: (providerEntryKey: string) => void;
  readonly onQueryChange: (query: string) => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.activeProvider];
  const PickerProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.pickerProvider];
  const triggerTraitParts =
    props.triggerTraitSummary
      ?.split(" · ")
      .map((part) => part.trim())
      .filter((part) => part.length > 0) ?? [];
  const visibleTraitLabel = triggerTraitParts
    .filter((part) => !part.toLowerCase().includes("fast"))
    .join(" · ");
  const showFastTraitIcon = triggerTraitParts.some((part) => part.toLowerCase().includes("fast"));
  const pickerModelCount = props.showFavoritesView
    ? props.allFavoriteRows.length
    : props.pickerRows.length;

  return (
    <Menu open={props.isMenuOpen} onOpenChange={props.onMenuOpenChange}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={
              props.triggerSurface === "settings" ? "ghost" : (props.triggerVariant ?? "ghost")
            }
            data-chat-provider-model-picker="true"
            className={cn(
              props.triggerSurface === "settings"
                ? cn(
                    APP_SETTINGS_PICKER_TRIGGER_CLASS_NAME,
                    "min-w-0 max-w-none shrink-0 justify-start overflow-hidden whitespace-nowrap px-2.5 text-[13px] [&_svg]:mx-0",
                  )
                : cn(
                    APP_COMPOSER_CONTROL_CLASS_NAME,
                    "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2.5 [&_svg]:mx-0",
                    props.compact ? "max-w-40 shrink-0" : "max-w-[min(48vw,16rem)] shrink-0",
                  ),
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-1.5 overflow-hidden",
            props.compact ? "max-w-34 sm:pl-0.5" : undefined,
          )}
        >
          <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
            <ProviderIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0",
                providerIconClassName(props.activeProvider, "text-muted-foreground"),
                props.activeProviderIconClassName,
              )}
            />
            {props.selectedProviderInstance ? (
              <ProviderInstanceBadge
                color={props.selectedProviderInstance.badgeColor}
                icon={props.selectedProviderInstance.badgeIcon}
                className="absolute -bottom-1 -right-1 size-3.5 border-[1.5px] p-[2px]"
              />
            ) : null}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
            <span className="min-w-0 truncate text-foreground/88">{props.selectedModelLabel}</span>
            {props.triggerTraitSummary ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 text-muted-foreground/75"
                title={props.triggerTraitSummary}
                aria-label={props.triggerTraitSummary}
              >
                {visibleTraitLabel ? (
                  <span className="max-w-18 truncate text-muted-foreground/72">
                    {visibleTraitLabel}
                  </span>
                ) : null}
                {showFastTraitIcon ? (
                  <IconBoltFilled aria-hidden="true" className="size-3" />
                ) : null}
                <span className="sr-only">{props.triggerTraitSummary}</span>
              </span>
            ) : null}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 opacity-50" />
        </span>
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="w-[min(calc(100vw-1rem),20.5rem)] overflow-hidden rounded-[1.15rem] border-border/50 bg-[color:color-mix(in_oklch,var(--popover)_97%,var(--background)_3%)] shadow-[0_24px_70px_-46px_rgb(0_0_0/.58)] supports-[backdrop-filter]:backdrop-blur-2xl supports-[backdrop-filter]:backdrop-saturate-[1.14] dark:border-border/40 dark:bg-[color:color-mix(in_oklch,var(--popover)_94%,var(--background)_6%)] dark:shadow-[0_24px_70px_-44px_rgb(0_0_0/.86)]"
        listClassName="overflow-hidden p-0"
        listHeight={MODEL_MENU_MAX_HEIGHT}
        listMaxHeight={MODEL_MENU_MAX_HEIGHT}
      >
        {props.displayedProviderEntries.length === 0 ? (
          <MenuItem disabled>No providers available.</MenuItem>
        ) : (
          <div
            className={cn(
              "flex h-full min-h-0 w-full flex-col overflow-hidden",
              props.showProviderRail ? "pt-1" : undefined,
            )}
          >
            {props.showProviderRail ? (
              <div className="overflow-hidden border-b border-border/28 px-2 pb-1.5">
                <div
                  className="flex gap-1 overflow-x-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  data-provider-model-picker-provider-rail="true"
                >
                  {props.allFavoriteRows.length > 0 ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Favorites"
                            className={cn(
                              "relative flex size-8 shrink-0 items-center justify-center rounded-[0.65rem] border outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                              props.showFavoritesView
                                ? "border-border/50 bg-foreground/[0.075] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/.055)] dark:bg-white/[0.085]"
                                : "border-transparent text-muted-foreground/68 hover:border-border/35 hover:bg-foreground/[0.055] hover:text-foreground dark:hover:bg-white/[0.07]",
                            )}
                            onClick={() => props.onProviderEntryFocus(FAVORITES_PROVIDER_ENTRY_KEY)}
                          />
                        }
                      >
                        <StarIcon
                          aria-hidden="true"
                          className={cn(
                            "size-4 shrink-0 transition-transform duration-150",
                            props.showFavoritesView && "scale-110 fill-current text-amber-500",
                          )}
                        />
                      </TooltipTrigger>
                      <TooltipPopup side="right">Favorites</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {props.displayedProviderEntries.map((entry) => {
                    const OptionIcon = PROVIDER_ICON_BY_PROVIDER[entry.provider];
                    const selected =
                      !props.showFavoritesView &&
                      props.pickerProviderEntryKey ===
                        makeProviderEntryKey(entry.provider, entry.instanceId);
                    return (
                      <Tooltip key={makeProviderEntryKey(entry.provider, entry.instanceId)}>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={entry.label}
                              className={cn(
                                "relative flex size-8 shrink-0 items-center justify-center rounded-[0.65rem] border outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                                selected
                                  ? "border-border/50 bg-foreground/[0.075] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/.055)] dark:bg-white/[0.085]"
                                  : "border-transparent text-muted-foreground/68 hover:border-border/35 hover:bg-foreground/[0.055] hover:text-foreground dark:hover:bg-white/[0.07]",
                              )}
                              onClick={() => props.onProviderEntryFocus(entry)}
                            />
                          }
                        >
                          <OptionIcon
                            aria-hidden="true"
                            className={cn(
                              "size-4 shrink-0 transition-transform duration-150",
                              providerIconClassName(entry.provider, "text-muted-foreground"),
                              selected && "scale-110",
                            )}
                          />
                          {entry.instanceId ? (
                            <ProviderInstanceBadge
                              color={entry.badgeColor}
                              icon={entry.badgeIcon}
                              className="absolute -bottom-0.5 -right-0.5 size-3.5 border-[1.5px] p-[2px]"
                            />
                          ) : null}
                        </TooltipTrigger>
                        <TooltipPopup side="right">{entry.label}</TooltipPopup>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div className="border-b border-border/26 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[0.65rem] border border-border/42 bg-foreground/[0.045] text-muted-foreground shadow-[inset_0_1px_0_rgb(255_255_255/.045)] dark:bg-white/[0.055]">
                    {props.showFavoritesView ? (
                      <StarIcon aria-hidden="true" className="size-4 shrink-0 fill-current" />
                    ) : (
                      <PickerProviderIcon
                        aria-hidden="true"
                        className={cn(
                          "size-4 shrink-0",
                          providerIconClassName(props.pickerProvider, "text-muted-foreground"),
                        )}
                      />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-1.5 truncate text-[12.5px] font-medium leading-4 text-foreground/92">
                      <span className="truncate">
                        {props.showFavoritesView ? "Favorites" : props.pickerProviderOption.label}
                      </span>
                      <span className="shrink-0 text-[10.5px] font-normal text-muted-foreground/58">
                        {pickerModelCount} {pickerModelCount === 1 ? "model" : "models"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px] leading-3 text-muted-foreground/62">
                      {props.showFavoritesView ? (
                        <span className="truncate">All providers</span>
                      ) : props.pickerProviderEntry.instanceId ? (
                        <span className="truncate">{props.pickerProviderEntry.accountLabel}</span>
                      ) : null}
                    </div>
                  </div>
                  {props.showFavoritesView ? null : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={`${props.pickerProviderEntryPinned ? "Unpin" : "Pin"} ${props.pickerProviderEntry.label}`}
                            className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground/58 outline-none transition-colors duration-150 hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => props.onProviderPinToggle(props.pickerProviderEntryKey)}
                          />
                        }
                      >
                        <PinIcon
                          aria-hidden="true"
                          className={cn(
                            "size-3.5 transition-transform duration-200",
                            props.pickerProviderEntryPinned
                              ? "fill-current text-primary scale-110"
                              : undefined,
                          )}
                        />
                      </TooltipTrigger>
                      <TooltipPopup side="left">
                        {props.pickerProviderEntryPinned ? "Unpin provider" : "Pin provider"}
                      </TooltipPopup>
                    </Tooltip>
                  )}
                </div>
              </div>
              <div className="border-b border-border/26 px-3 py-2">
                <div className="flex h-8 items-center gap-2 rounded-[0.75rem] border border-border/42 bg-foreground/[0.035] px-2.5 transition-colors duration-150 focus-within:border-primary/38 focus-within:bg-foreground/[0.045] focus-within:ring-2 focus-within:ring-primary/10 dark:bg-white/[0.045] dark:focus-within:bg-white/[0.06]">
                  <SearchIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground/58"
                  />
                  <input
                    type="search"
                    aria-label="Search models"
                    value={props.query}
                    onChange={(event) => props.onQueryChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") {
                        event.stopPropagation();
                      }
                    }}
                    placeholder="Search models"
                    className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/48"
                  />
                </div>
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1.5"
                data-provider-model-picker-model-list="true"
              >
                {props.showFavoritesView ? (
                  <>
                    <div className="px-2.5 pb-1 pt-1 text-[9.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/52">
                      Favorites
                    </div>
                    {props.allFavoriteRows.length === 0 ? (
                      <div className="rounded-[0.8rem] border border-border/32 bg-foreground/[0.025] px-3 py-3 text-center text-[12px] text-muted-foreground/62 dark:bg-white/[0.035]">
                        No favorite models yet.
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        {props.allFavoriteRows.map((row) => (
                          <ProviderModelPickerRenderedRow
                            key={`favorite:${row.favoriteKey}`}
                            activeProvider={props.activeProvider}
                            favoriteModelSet={props.favoriteModelSet}
                            providerInstanceId={props.providerInstanceId}
                            row={row}
                            section="favorite"
                            selectedModel={props.selectedModel}
                            showProviderIcon={props.showFavoritesView}
                            traitsMenuContent={
                              props.renderTraitsMenuContent?.(row.selectionValue) ??
                              props.traitsMenuContent
                            }
                            onFavoriteModelToggle={props.onFavoriteModelToggle}
                            onModelSelect={props.onModelSelect}
                          />
                        ))}
                      </div>
                    )}
                  </>
                ) : props.currentModelRow ? (
                  <>
                    <div className="px-2.5 pb-1 pt-1 text-[9.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/52">
                      Current
                    </div>
                    <div className="space-y-0.5">
                      <ProviderModelPickerRenderedRow
                        key={`current:${props.currentModelRow.favoriteKey}`}
                        activeProvider={props.activeProvider}
                        favoriteModelSet={props.favoriteModelSet}
                        providerInstanceId={props.providerInstanceId}
                        row={props.currentModelRow}
                        section="current"
                        selectedModel={props.selectedModel}
                        showProviderIcon={props.showFavoritesView}
                        traitsMenuContent={
                          props.renderTraitsMenuContent?.(props.currentModelRow.selectionValue) ??
                          props.traitsMenuContent
                        }
                        onFavoriteModelToggle={props.onFavoriteModelToggle}
                        onModelSelect={props.onModelSelect}
                      />
                    </div>
                    <div
                      aria-hidden="true"
                      className="mx-3 my-1.5 h-px origin-center scale-y-50 bg-gradient-to-r from-transparent via-border/42 to-transparent"
                    />
                  </>
                ) : null}

                {!props.showFavoritesView && props.favoriteRows.length > 0 ? (
                  <>
                    <div className="px-2.5 pb-1 pt-1 text-[9.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/52">
                      Favorites
                    </div>
                    <div className="space-y-0.5">
                      {props.favoriteRows.map((row) => (
                        <ProviderModelPickerRenderedRow
                          key={`favorite:${row.favoriteKey}`}
                          activeProvider={props.activeProvider}
                          favoriteModelSet={props.favoriteModelSet}
                          providerInstanceId={props.providerInstanceId}
                          row={row}
                          section="favorite"
                          selectedModel={props.selectedModel}
                          showProviderIcon={props.showFavoritesView}
                          traitsMenuContent={
                            props.renderTraitsMenuContent?.(row.selectionValue) ??
                            props.traitsMenuContent
                          }
                          onFavoriteModelToggle={props.onFavoriteModelToggle}
                          onModelSelect={props.onModelSelect}
                        />
                      ))}
                    </div>
                    <div
                      aria-hidden="true"
                      className="mx-3 my-1.5 h-px origin-center scale-y-50 bg-gradient-to-r from-transparent via-border/42 to-transparent"
                    />
                  </>
                ) : null}

                {!props.showFavoritesView ? (
                  <>
                    <div className="px-2.5 pb-1 pt-1 text-[9.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/52">
                      Models
                    </div>
                    {props.modelRows.length === 0 ? (
                      <div className="rounded-[0.8rem] border border-border/32 bg-foreground/[0.025] px-3 py-3 text-center text-[12px] text-muted-foreground/62 dark:bg-white/[0.035]">
                        {props.query.trim().length > 0
                          ? "No models match your search."
                          : "No models available."}
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        {props.modelRows.map((row) => (
                          <ProviderModelPickerRenderedRow
                            key={`all:${row.favoriteKey}`}
                            activeProvider={props.activeProvider}
                            favoriteModelSet={props.favoriteModelSet}
                            providerInstanceId={props.providerInstanceId}
                            row={row}
                            section="all"
                            selectedModel={props.selectedModel}
                            showProviderIcon={props.showFavoritesView}
                            traitsMenuContent={
                              props.renderTraitsMenuContent?.(row.selectionValue) ??
                              props.traitsMenuContent
                            }
                            onFavoriteModelToggle={props.onFavoriteModelToggle}
                            onModelSelect={props.onModelSelect}
                          />
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </MenuPopup>
    </Menu>
  );
}

function deriveProviderModelPickerViewState(input: {
  readonly focusedProviderEntryKey: string | null;
  readonly prefs: ProviderModelPickerPrefs;
  readonly props: ProviderModelPickerProps;
}) {
  const props = input.props;
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderSnapshot = props.providers
    ? getProviderSnapshot(props.providers, activeProvider, props.providerInstanceId)
    : undefined;
  const selectedProviderOptions =
    selectedProviderSnapshot?.models.length === 0
      ? props.modelOptionsByProvider[activeProvider]
      : selectedProviderSnapshot
        ? modelOptionsFromServerModels(selectedProviderSnapshot.models)
        : props.modelOptionsByProvider[activeProvider];
  const cursorModels = props.providers
    ? (getProviderSnapshot(
        props.providers,
        "cursor",
        activeProvider === "cursor" ? props.providerInstanceId : undefined,
      )?.models ?? [])
    : [];
  const selectedCursorModel =
    activeProvider === "cursor"
      ? resolveExactCursorModelSelection({
          models: cursorModels,
          model: props.model,
        })
      : null;
  const selectedCursorFamily =
    activeProvider === "cursor" && selectedCursorModel
      ? resolveCursorSelectorFamily(cursorModels, selectedCursorModel)
      : null;
  const selectedModelLabel =
    activeProvider === "cursor"
      ? (selectedCursorFamily?.familyName ?? props.model)
      : (selectedProviderOptions.find((option) => option.slug === props.model)?.name ??
        props.model);
  const selectedProviderInstance =
    props.providerInstanceId && props.providerInstanceId !== "default"
      ? props.providerInstancesByProvider?.[activeProvider]?.find(
          (instance) => instance.id === props.providerInstanceId,
        )
      : undefined;

  const selectableProviderOptions = (() => {
    const providers = props.providers;
    return !providers
      ? AVAILABLE_PROVIDER_OPTIONS
      : AVAILABLE_PROVIDER_OPTIONS.filter(
          (option) =>
            isSelectableLiveProvider(getProviderSnapshot(providers, option.value)) ||
            (props.providerInstancesByProvider?.[option.value]?.some(
              (instance) => instance.enabled,
            ) ??
              false),
        );
  })();
  const selectableProviderEntries = (() => {
    const providers = props.providers;
    return buildProviderEntryRows(
      buildProviderPickerEntries({
        defaultProviderSelectableByProvider: providers
          ? Object.fromEntries(
              AVAILABLE_PROVIDER_OPTIONS.map((option) => [
                option.value,
                isSelectableLiveProvider(getProviderSnapshot(providers, option.value)),
              ]),
            )
          : undefined,
        options: selectableProviderOptions,
        providerInstancesByProvider: props.providerInstancesByProvider,
      }),
      input.prefs.pinnedProviders,
    );
  })();
  const lockedProviderEntries = (() => {
    if (props.lockedProvider === null) {
      return [];
    }
    const option = AVAILABLE_PROVIDER_OPTIONS.find(
      (candidate) => candidate.value === props.lockedProvider,
    );
    if (!option) {
      return [];
    }
    const selectedDefaultInstance =
      props.provider === props.lockedProvider &&
      normalizeProviderInstanceId(props.providerInstanceId) === "default";
    const includeDefault =
      selectedDefaultInstance ||
      !props.providers ||
      isSelectableLiveProvider(getProviderSnapshot(props.providers, props.lockedProvider));
    return buildProviderEntryRows(
      buildProviderPickerEntries({
        defaultProviderSelectableByProvider: {
          [props.lockedProvider]: includeDefault,
        },
        options: [option],
        providerInstancesByProvider: props.providerInstancesByProvider,
      }),
      input.prefs.pinnedProviders,
    );
  })();
  const displayedProviderEntries =
    props.lockedProvider === null ? selectableProviderEntries : lockedProviderEntries;
  const activeProviderEntryKey = makeProviderEntryKey(activeProvider, props.providerInstanceId);

  const pickerProviderEntry = (() => {
    const scopedEntries =
      props.lockedProvider === null ? selectableProviderEntries : lockedProviderEntries;
    const focusedEntry = input.focusedProviderEntryKey
      ? scopedEntries.find(
          (entry) =>
            makeProviderEntryKey(entry.provider, entry.instanceId) ===
            input.focusedProviderEntryKey,
        )
      : undefined;
    if (focusedEntry) {
      return focusedEntry;
    }
    if (props.lockedProvider !== null) {
      return {
        provider: props.lockedProvider,
        instanceId:
          props.provider === props.lockedProvider && props.providerInstanceId !== "default"
            ? props.providerInstanceId
            : undefined,
        accountLabel:
          props.provider === props.lockedProvider && props.providerInstanceId
            ? (props.providerInstancesByProvider?.[props.lockedProvider]?.find(
                (instance) => instance.id === props.providerInstanceId,
              )?.label ?? props.providerInstanceId)
            : "Default",
        label:
          AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === props.lockedProvider)
            ?.label ?? props.lockedProvider,
      } satisfies ProviderPickerEntry;
    }
    const selectedEntry = selectableProviderEntries.find(
      (entry) => makeProviderEntryKey(entry.provider, entry.instanceId) === activeProviderEntryKey,
    );
    if (selectedEntry) {
      return selectedEntry;
    }
    return (
      selectableProviderEntries[0] ?? {
        provider: props.provider,
        instanceId: props.providerInstanceId,
        accountLabel:
          props.providerInstanceId && props.providerInstanceId !== "default"
            ? (props.providerInstancesByProvider?.[props.provider]?.find(
                (instance) => instance.id === props.providerInstanceId,
              )?.label ?? props.providerInstanceId)
            : "Default",
        label:
          AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === props.provider)?.label ??
          props.provider,
      }
    );
  })();
  const pickerProvider = pickerProviderEntry.provider;
  const pickerProviderInstanceId = pickerProviderEntry.instanceId;
  const pickerProviderEntryKey = makeProviderEntryKey(pickerProvider, pickerProviderInstanceId);
  const pickerProviderSnapshot = props.providers
    ? getProviderSnapshot(props.providers, pickerProvider, pickerProviderInstanceId)
    : undefined;
  const pickerProviderModels = pickerProviderSnapshot?.models ?? EMPTY_SERVER_PROVIDER_MODELS;
  const pickerModelOptions =
    pickerProviderSnapshot?.models.length === 0
      ? props.modelOptionsByProvider[pickerProvider]
      : pickerProviderSnapshot
        ? modelOptionsFromServerModels(pickerProviderSnapshot.models)
        : props.modelOptionsByProvider[pickerProvider];
  const pickerRows =
    pickerProvider === "cursor" && pickerProviderModels.length > 0
      ? buildCursorModelRows({
          models: pickerProviderModels,
          providerInstanceId: pickerProviderInstanceId,
          selectedModel: props.model,
        })
      : buildStandardModelRows(pickerProvider, pickerProviderInstanceId, pickerModelOptions);
  const favoriteModelSet = new Set(input.prefs.favoriteModels);
  const allFavoriteRows = displayedProviderEntries.flatMap((entry) => {
    const entrySnapshot = props.providers
      ? getProviderSnapshot(props.providers, entry.provider, entry.instanceId)
      : undefined;
    const entryModels = entrySnapshot?.models ?? EMPTY_SERVER_PROVIDER_MODELS;
    const entryOptions =
      entrySnapshot?.models.length === 0
        ? props.modelOptionsByProvider[entry.provider]
        : entrySnapshot
          ? modelOptionsFromServerModels(entrySnapshot.models)
          : props.modelOptionsByProvider[entry.provider];
    const rows =
      entry.provider === "cursor" && entryModels.length > 0
        ? buildCursorModelRows({
            models: entryModels,
            providerInstanceId: entry.instanceId,
            selectedModel: props.model,
          })
        : buildStandardModelRows(entry.provider, entry.instanceId, entryOptions);
    return rows.filter((row) => favoriteModelSet.has(row.favoriteKey));
  });
  const activeRows =
    activeProvider === "cursor" && cursorModels.length > 0
      ? buildCursorModelRows({
          models: cursorModels,
          providerInstanceId: props.providerInstanceId,
          selectedModel: props.model,
        })
      : buildStandardModelRows(activeProvider, props.providerInstanceId, selectedProviderOptions);
  const pickerShowsActiveProvider =
    activeProvider === pickerProvider &&
    normalizeProviderInstanceId(props.providerInstanceId) ===
      normalizeProviderInstanceId(pickerProviderInstanceId);
  const currentModelRow = pickerShowsActiveProvider
    ? (activeRows.find((row) => isRowSelected(activeProvider, row, props.model)) ?? null)
    : null;
  const pickerProviderEntryPinned = isProviderEntryPinned(
    input.prefs.pinnedProviders,
    pickerProviderEntry,
  );

  return {
    activeProvider,
    activeProviderEntryKey,
    allFavoriteRows,
    displayedProviderEntries,
    favoriteModelSet,
    currentModelRow,
    pickerModelOptions,
    pickerProvider,
    pickerProviderEntry,
    pickerProviderEntryKey,
    pickerProviderEntryPinned,
    pickerProviderInstanceId,
    pickerProviderOption:
      AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === pickerProvider) ??
      AVAILABLE_PROVIDER_OPTIONS[0]!,
    pickerRows,
    selectedModelLabel,
    selectedProviderInstance,
    showProviderRail: displayedProviderEntries.length > 1,
  };
}

export function ProviderModelPicker(props: ProviderModelPickerProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [focusedProviderEntryKey, setFocusedProviderEntryKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useLocalStorage(
    PROVIDER_PICKER_PREFS_STORAGE_KEY,
    EMPTY_PROVIDER_MODEL_PICKER_PREFS,
    ProviderModelPickerPrefsSchema,
  );
  const {
    activeProvider,
    activeProviderEntryKey,
    allFavoriteRows,
    displayedProviderEntries,
    favoriteModelSet,
    currentModelRow,
    pickerModelOptions,
    pickerProvider,
    pickerProviderEntry,
    pickerProviderEntryKey,
    pickerProviderEntryPinned,
    pickerProviderInstanceId,
    pickerProviderOption,
    pickerRows,
    selectedModelLabel,
    selectedProviderInstance,
    showProviderRail,
  } = deriveProviderModelPickerViewState({
    focusedProviderEntryKey,
    prefs,
    props,
  });
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows =
    normalizedQuery.length === 0
      ? pickerRows
      : pickerRows.filter((row) => row.searchText.includes(normalizedQuery));
  const visibleAllFavoriteRows =
    normalizedQuery.length === 0
      ? allFavoriteRows
      : allFavoriteRows.filter((row) => row.searchText.includes(normalizedQuery));
  const favoriteRows = visibleRows.filter((row) => favoriteModelSet.has(row.favoriteKey));
  const modelRows = visibleRows.filter((row) => !favoriteModelSet.has(row.favoriteKey));

  const handleModelChange = (
    provider: ProviderKind,
    value: string,
    options?: ReadonlyArray<{ slug: string; name: string }>,
    closeMenu = true,
    providerInstanceId?: string,
  ) => {
    if (props.disabled) return;
    if (!value) return;
    const modelOptions =
      options ??
      (provider === pickerProvider ? pickerModelOptions : props.modelOptionsByProvider[provider]);
    const nextProviderInstanceId =
      providerInstanceId ?? (pickerProvider === provider ? pickerProviderInstanceId : undefined);
    const resolvedModel =
      provider === "cursor" ? value : resolveSelectableModel(provider, value, modelOptions);
    if (!resolvedModel) return;
    if (nextProviderInstanceId === undefined) {
      props.onProviderModelChange(provider, resolvedModel);
    } else {
      props.onProviderModelChange(provider, resolvedModel, nextProviderInstanceId);
    }
    if (closeMenu) {
      setIsMenuOpen(false);
    }
  };
  const handleProviderEntryFocus = (
    entry: ProviderPickerEntry | typeof FAVORITES_PROVIDER_ENTRY_KEY,
  ) => {
    if (props.disabled) return;
    if (entry === FAVORITES_PROVIDER_ENTRY_KEY) {
      setFocusedProviderEntryKey(FAVORITES_PROVIDER_ENTRY_KEY);
      setQuery("");
      return;
    }
    const entryKey = makeProviderEntryKey(entry.provider, entry.instanceId);
    setFocusedProviderEntryKey(entryKey);
    setQuery("");
  };
  const togglePinnedProvider = (providerEntryKey: string) => {
    setPrefs((previous) => ({
      favoriteModels: dedupeStrings(previous.favoriteModels),
      pinnedProviders: toggleString(dedupeStrings(previous.pinnedProviders), providerEntryKey),
    }));
  };
  const toggleFavoriteModel = (favoriteKey: string) => {
    setPrefs((previous) => ({
      favoriteModels: toggleString(dedupeStrings(previous.favoriteModels), favoriteKey),
      pinnedProviders: dedupeStrings(previous.pinnedProviders),
    }));
  };

  const modelMenu = (
    <ProviderModelPickerMenu
      activeProvider={activeProvider}
      activeProviderEntryKey={activeProviderEntryKey}
      activeProviderIconClassName={props.activeProviderIconClassName}
      compact={props.compact}
      disabled={props.disabled}
      allFavoriteRows={visibleAllFavoriteRows}
      displayedProviderEntries={displayedProviderEntries}
      favoriteModelSet={favoriteModelSet}
      favoriteRows={favoriteRows}
      currentModelRow={normalizedQuery.length === 0 ? currentModelRow : null}
      isMenuOpen={isMenuOpen}
      modelRows={modelRows}
      pickerProvider={pickerProvider}
      pickerProviderEntry={pickerProviderEntry}
      pickerProviderEntryKey={pickerProviderEntryKey}
      pickerProviderEntryPinned={pickerProviderEntryPinned}
      pickerProviderInstanceId={pickerProviderInstanceId}
      pickerProviderOption={pickerProviderOption}
      pickerRows={pickerRows}
      providerInstanceId={props.providerInstanceId}
      query={query}
      selectedModel={props.model}
      selectedModelLabel={selectedModelLabel}
      selectedProviderInstance={selectedProviderInstance}
      showProviderRail={showProviderRail}
      showFavoritesView={focusedProviderEntryKey === FAVORITES_PROVIDER_ENTRY_KEY}
      triggerClassName={props.triggerClassName}
      triggerSurface={props.triggerSurface}
      triggerTraitSummary={props.triggerTraitSummary}
      triggerVariant={props.triggerVariant}
      renderTraitsMenuContent={props.renderTraitsMenuContent}
      traitsMenuContent={props.traitsMenuContent}
      onFavoriteModelToggle={toggleFavoriteModel}
      onMenuOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        if (open) {
          setFocusedProviderEntryKey(activeProviderEntryKey);
        }
        setIsMenuOpen(open);
      }}
      onModelSelect={(row) =>
        handleModelChange(
          row.provider,
          row.selectionValue,
          undefined,
          false,
          row.providerInstanceId,
        )
      }
      onProviderEntryFocus={handleProviderEntryFocus}
      onProviderPinToggle={togglePinnedProvider}
      onQueryChange={setQuery}
    />
  );

  if (!props.handoff || props.handoff.disabled || props.handoff.providers.length === 0) {
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
        triggerClassName={cn(APP_COMPOSER_CONTROL_CLASS_NAME, "size-7")}
        triggerVariant={props.triggerVariant ?? "ghost"}
        onSelect={(provider, mode) => {
          props.handoff?.onSelect(provider, mode);
        }}
      />
    </div>
  );
}
