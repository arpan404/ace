import {
  spadeAccountLabels,
  spadeAccountState,
  spadeLocalFirst,
  spadeModelFacts,
  spadeModelGroups,
  spadeWorksWell,
  type SpadeEndpoint,
  type SpadeModelInfo,
  type SpadeModelOption,
  type SpadeModelSources,
} from "@ace/ui-core/spade-chat";
import {
  ArrowClockwiseIcon,
  CheckIcon,
  DesktopIcon,
  MagnifyingGlassIcon,
  StarIcon,
} from "@ace/icons";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { SpadeModelMark, SpadeProviderMark } from "./spade-marks.tsx";
import { SpadeModelCapabilities } from "./spade-model-capabilities.tsx";

const panelHeight = 360;
const numbered = 9;
const favoritesStorageKey = "ace.spade.models.favorites";
const localTabId = "__local__";
const favoritesTabId = "__favorites__";

const tabButton =
  "relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-accent/60 hover:text-foreground focus-ring-inset aria-selected:bg-accent aria-selected:text-foreground pointer-coarse:size-8";

interface RailTab {
  id: string;
  label: string;
  kind: "favorites" | "endpoint" | "local";
  endpoint?: SpadeEndpoint | undefined;
  /** Shown as a tiny corner badge when a provider has multiple accounts. */
  badge?: string | undefined;
  reason?: string | undefined;
  tone?: ReturnType<typeof spadeAccountState>["tone"] | undefined;
}

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(favoritesStorageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeFavorites(next: readonly string[]): void {
  try {
    localStorage.setItem(favoritesStorageKey, JSON.stringify(next));
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

function useSpadeFavorites() {
  const [favorites, setFavorites] = useState<string[]>(readFavorites);
  const toggle = (value: string) => {
    setFavorites((before) => {
      const next = before.includes(value)
        ? before.filter((item) => item !== value)
        : [value, ...before];
      writeFavorites(next);
      return next;
    });
  };
  return { favorites, toggle };
}

function accountBadge(endpoint: SpadeEndpoint): string {
  const trimmed = endpoint.name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "•";
}

/**
 * Ace main model picker panel adapted for Spade's endpoints, accounts, and local servers:
 * left vertical provider/account rail (Favorites + each account with its mark + un-added local
 * servers), integrated search bar with live refresh, and two-line model rows with ⌘1–9 and stars.
 */
export function SpadeModelPickerPanel(props: {
  sources: SpadeModelSources;
  value: string;
  keychain: boolean;
  now: number;
  none: string | undefined;
  noneFacts?: string | undefined;
  /** Hide the left rail (single-endpoint picker). */
  only?: boolean | undefined;
  refreshing?: boolean | undefined;
  disabled?: boolean | undefined;
  onRefresh?: (() => void) | undefined;
  onPick(option: SpadeModelOption): void;
  onClose?(): void;
}) {
  const { favorites, toggle: toggleFavorite } = useSpadeFavorites();
  const orderedEndpoints = useMemo(
    () => spadeLocalFirst(props.sources.endpoints, (each) => each.endpoint.local),
    [props.sources.endpoints],
  );
  const labels = useMemo(
    () => spadeAccountLabels(orderedEndpoints.map((each) => each.endpoint)),
    [orderedEndpoints],
  );
  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { endpoint } of orderedEndpoints) {
      const key = endpoint.provider ?? endpoint.id;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [orderedEndpoints]);
  const endpointById = useMemo(
    () => new Map(orderedEndpoints.map(({ endpoint }) => [endpoint.id, endpoint])),
    [orderedEndpoints],
  );
  const modelInfoByValue = useMemo(() => {
    const map = new Map<string, SpadeModelInfo>();
    for (const { endpoint, models } of orderedEndpoints) {
      for (const model of models) {
        map.set(`${endpoint.id}/${model.id}`, model);
      }
    }
    return map;
  }, [orderedEndpoints]);

  const tabs: RailTab[] = useMemo(() => {
    if (props.only) return [];
    const out: RailTab[] = [];
    if (orderedEndpoints.length > 0 || (props.sources.adds?.length ?? 0) > 0) {
      out.push({ id: favoritesTabId, label: "Favorites", kind: "favorites" });
    }
    for (const { endpoint } of orderedEndpoints) {
      const state = spadeAccountState(endpoint, props.keychain, props.now);
      const label = labels.get(endpoint.id) ?? endpoint.name;
      const groupKey = endpoint.provider ?? endpoint.id;
      const multiple = (providerCounts.get(groupKey) ?? 0) > 1;
      out.push({
        id: endpoint.id,
        label,
        kind: "endpoint",
        endpoint,
        badge: multiple ? accountBadge(endpoint) : undefined,
        reason: state.tone !== "ready" ? state.text : undefined,
        tone: state.tone,
      });
    }
    if ((props.sources.adds?.length ?? 0) > 0) {
      out.push({ id: localTabId, label: "On this computer", kind: "local" });
    }
    return out;
  }, [
    props.only,
    orderedEndpoints,
    props.sources.adds,
    props.keychain,
    props.now,
    labels,
    providerCounts,
  ]);

  const currentEndpointId = props.value ? props.value.split("/")[0] : undefined;
  const defaultTab = useMemo(() => {
    if (props.only) return orderedEndpoints[0]?.endpoint.id ?? favoritesTabId;
    if (currentEndpointId && tabs.some((tab) => tab.id === currentEndpointId)) {
      return currentEndpointId;
    }
    if (favorites.length > 0 && tabs.some((tab) => tab.id === favoritesTabId)) {
      return favoritesTabId;
    }
    const firstReady = tabs.find((tab) => tab.kind === "endpoint" && !tab.reason);
    if (firstReady) return firstReady.id;
    const firstSource = tabs.find((tab) => tab.kind !== "favorites");
    return firstSource?.id ?? favoritesTabId;
  }, [props.only, orderedEndpoints, currentEndpointId, tabs, favorites.length]);

  const [chosenTab, setChosenTab] = useState<string>();
  const [followTab, setFollowTab] = useState<string>();
  const activeTabId =
    followTab && tabs.some((tab) => tab.id === followTab)
      ? followTab
      : chosenTab && tabs.some((tab) => tab.id === chosenTab)
        ? chosenTab
        : defaultTab;
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const isFavorites = !searching && !props.only && activeTabId === favoritesTabId;
  const mixed = (searching && orderedEndpoints.length > 1) || isFavorites;

  // Build visible groups based on active tab or search query.
  const allGroups = useMemo(
    () => spadeModelGroups(props.sources, query, props.none, props.noneFacts),
    [props.sources, query, props.none, props.noneFacts],
  );

  const visibleGroups = useMemo(() => {
    if (props.only || searching) return allGroups;
    const emptyGroup = allGroups.find((group) => group.label === undefined);
    if (isFavorites) {
      const favSet = new Set(favorites);
      const favOptions = allGroups
        .filter((group) => group.label !== undefined)
        .flatMap((group) => group.options)
        .filter((option) => !option.typed && favSet.has(option.value));
      return [
        ...(emptyGroup ? [emptyGroup] : []),
        ...(favOptions.length ? [{ label: "Favorites", options: favOptions }] : []),
      ];
    }
    if (activeTabId === localTabId) {
      const localGroup = allGroups.find((group) => group.label === "On this computer");
      return [...(emptyGroup ? [emptyGroup] : []), ...(localGroup ? [localGroup] : [])];
    }
    const targetLabel = labels.get(activeTabId);
    const matching = targetLabel ? allGroups.filter((group) => group.label === targetLabel) : [];
    return [...(emptyGroup ? [emptyGroup] : []), ...matching];
  }, [props.only, searching, allGroups, isFavorites, favorites, activeTabId, labels]);

  const flat = useMemo(() => visibleGroups.flatMap((group) => group.options), [visibleGroups]);
  const starts = useMemo(
    () =>
      visibleGroups.map((_, index) =>
        visibleGroups.slice(0, index).reduce((sum, group) => sum + group.options.length, 0),
      ),
    [visibleGroups],
  );
  const startIndex = useMemo(() => {
    const at = flat.findIndex((option) => option.value === props.value && !option.typed);
    return at >= 0 ? at : 0;
  }, [flat, props.value]);

  const [highlight, setHighlight] = useState<number>();
  const active = flat.length ? Math.min(highlight ?? startIndex, flat.length - 1) : 0;

  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const pane = listRef.current;
    const row = document.getElementById(`${listId}-${active}`);
    if (!pane || !row) return;
    const bounds = pane.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < bounds.top) pane.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) pane.scrollTop += item.bottom - bounds.bottom;
  }, [listId, active]);

  const pickOption = (option: SpadeModelOption | undefined) => {
    if (!option || props.disabled) return;
    if (option.adds) setFollowTab(option.adds.server);
    props.onPick(option);
  };

  const selectTab = (id: string) => {
    setFollowTab(undefined);
    setChosenTab(id);
    setQuery("");
    setHighlight(0);
  };

  const onPanelKeyDown = (event: KeyboardEvent) => {
    if (
      !props.only &&
      (event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey)) &&
      event.target === searchRef.current &&
      (event.key === "Tab" || searchRef.current.selectionStart === 0)
    ) {
      event.preventDefault();
      railRef.current?.querySelector<HTMLElement>(`[data-tab="${activeTabId}"]`)?.focus();
      return;
    }
    if (event.key === "Escape" && props.onClose) {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      const selectable = flat.filter((option) => option.value !== "" && !option.typed);
      const quick = selectable[Number(event.key) - 1];
      if (quick && !quick.cant) pickOption(quick);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!flat.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pickOption(flat[active] ?? flat[0]);
    }
  };

  const onRailKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const focused =
      event.target instanceof HTMLElement
        ? event.target.closest("[data-tab]")?.getAttribute("data-tab")
        : null;
    const at = tabs.findIndex((entry) => entry.id === (focused ?? activeTabId));
    const next =
      tabs[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (at + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length
      ];
    if (!next) return;
    selectTab(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };

  const nothing = props.sources.endpoints.length === 0 && !props.sources.adds?.length;
  const selectableModels = flat.filter((option) => option.value !== "" && !option.typed);
  const modelNumber = new Map(selectableModels.map((option, idx) => [option.value, idx + 1]));

  return (
    <div
      data-slot="model-picker"
      onKeyDownCapture={onPanelKeyDown}
      className="flex w-96 max-w-[calc(100vw-2rem)]"
      style={{ height: `min(${panelHeight}px, var(--available-height, ${panelHeight}px))` }}
    >
      {tabs.length > 0 && (
        <div
          ref={railRef}
          role="tablist"
          aria-label="Model sources"
          aria-orientation="vertical"
          onKeyDown={onRailKeyDown}
          className="flex min-h-0 w-10 shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto overscroll-contain border-r border-border py-1.5 scroll-quiet pointer-coarse:w-11"
        >
          {tabs.map((tab) => {
            const selected = !searching && activeTabId === tab.id;
            const tip = [tab.label, tab.reason].filter(Boolean).join(" · ");
            return (
              <Tip key={tab.id} label={tip} side="left">
                <button
                  type="button"
                  role="tab"
                  data-tab={tab.id}
                  aria-label={tab.label}
                  aria-selected={selected}
                  aria-controls={`${listId}-pane`}
                  tabIndex={activeTabId === tab.id ? 0 : -1}
                  onClick={() => selectTab(tab.id)}
                  className={cn(tabButton, tab.reason && "opacity-45")}
                >
                  {tab.kind === "favorites" ? (
                    <StarIcon aria-hidden size={16} weight={selected ? "fill" : "regular"} />
                  ) : tab.kind === "local" ? (
                    <DesktopIcon aria-hidden size={16} />
                  ) : (
                    tab.endpoint && (
                      <span className="relative inline-flex items-center justify-center">
                        <SpadeProviderMark
                          account={tab.endpoint}
                          name={tab.label}
                          size={16}
                          decorative
                        />
                        {tab.badge && (
                          <span
                            aria-hidden
                            className="absolute -right-1.5 -bottom-1 grid size-3 place-items-center rounded-full bg-popover text-[8px] leading-none font-semibold text-foreground ring-1 ring-border"
                          >
                            {tab.badge}
                          </span>
                        )}
                      </span>
                    )
                  )}
                  {selected && (
                    <span
                      aria-hidden
                      className="absolute top-1.5 -right-1.5 bottom-1.5 w-0.5 rounded-full bg-ring"
                    />
                  )}
                </button>
              </Tip>
            );
          })}
        </div>
      )}

      <div
        role="tabpanel"
        id={`${listId}-pane`}
        aria-label={mixed ? "Search results and favorites" : (activeTab?.label ?? "Models")}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div className="mx-2 flex h-8 shrink-0 items-center gap-2 border-b border-border text-subtle-foreground focus-within:border-ring/40">
          <label className="flex h-full min-w-0 flex-1 items-center gap-2">
            <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0" />
            <input
              ref={searchRef}
              role="combobox"
              aria-label="Search models"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={flat.length ? `${listId}-${active}` : undefined}
              placeholder="Search or type a model id…"
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={onSearchKeyDown}
              className="h-full min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground focus-visible:placeholder:text-muted-foreground"
            />
          </label>
          {props.refreshing && <Spinner label="Refreshing models" />}
          {props.onRefresh && (
            <IconButton
              icon={ArrowClockwiseIcon}
              label="Refresh models"
              size="sm"
              disabled={props.refreshing}
              onClick={props.onRefresh}
            />
          )}
        </div>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Models"
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1 [scrollbar-width:thin]"
        >
          {!mixed && activeTab?.reason && (
            <p
              role="status"
              className={cn(
                "px-2.5 py-1.5 text-xs",
                activeTab.tone === "action" ? "text-status-needs-you" : "text-muted-foreground",
              )}
            >
              {activeTab.reason}
            </p>
          )}

          {visibleGroups.map((group, groupAt) => (
            <div
              key={group.label ?? "__empty__"}
              role="group"
              aria-label={group.label ?? props.none}
              className={group.label === undefined ? "mb-1 border-b border-border pb-1" : undefined}
            >
              {group.options.map((option, optionAt) => {
                const index = (starts[groupAt] ?? 0) + optionAt;
                const endpointId = option.value.split("/")[0];
                const endpoint = endpointId ? endpointById.get(endpointId) : undefined;
                const modelId = endpointId ? option.value.slice(endpointId.length + 1) : "";
                const isEmpty = option.value === "";
                const chosen = option.value === props.value && !option.typed;
                const num = modelNumber.get(option.value);
                return (
                  <SpadePickerRow
                    key={`${option.value || "none"}-${option.typed ? "typed" : "list"}`}
                    id={`${listId}-${index}`}
                    option={option}
                    endpoint={endpoint}
                    modelInfo={option.typed ? undefined : modelInfoByValue.get(option.value)}
                    modelId={modelId}
                    mixed={mixed}
                    isEmpty={isEmpty}
                    chosen={chosen}
                    highlighted={active === index}
                    starred={!isEmpty && !option.typed && favorites.includes(option.value)}
                    number={num !== undefined && num <= numbered ? num : undefined}
                    onHighlight={() => setHighlight(index)}
                    onPick={() => pickOption(option)}
                    onStar={() => toggleFavorite(option.value)}
                  />
                );
              })}
            </div>
          ))}

          {nothing && (
            <EmptyPanel
              icon="search"
              title="No providers set up"
              hint="Add a provider in Models first"
            />
          )}
          {!nothing && flat.length === 0 && (
            <EmptyPanel
              icon={isFavorites ? "star" : "search"}
              title={
                searching
                  ? `No models match “${query.trim()}”`
                  : isFavorites
                    ? "No favorites yet"
                    : "No models"
              }
              hint={
                searching
                  ? "Search looks across every provider"
                  : isFavorites
                    ? "Star a model to keep it here"
                    : (activeTab?.reason ?? "This provider lists no models yet")
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SpadePickerRow(props: {
  id: string;
  option: SpadeModelOption;
  endpoint: SpadeEndpoint | undefined;
  modelInfo: SpadeModelInfo | undefined;
  modelId: string;
  mixed: boolean;
  isEmpty: boolean;
  chosen: boolean;
  highlighted: boolean;
  starred: boolean;
  number: number | undefined;
  onHighlight(): void;
  onPick(): void;
  onStar(): void;
}) {
  const { option, endpoint, modelInfo, isEmpty } = props;
  const revealed = props.highlighted || props.chosen;
  const showCapabilities = !isEmpty && !option.cant && (modelInfo?.capabilities.length ?? 0) > 0;
  const baseFacts =
    showCapabilities && modelInfo
      ? endpoint?.local
        ? [
            modelInfo.knownGood
              ? spadeWorksWell
              : spadeModelFacts({ context: modelInfo.context, capabilities: [] }),
            "Runs on this computer",
          ]
            .filter(Boolean)
            .join(" · ")
        : spadeModelFacts({ context: modelInfo.context, capabilities: [] })
      : option.facts;
  const subtitle = isEmpty
    ? option.facts
    : props.mixed
      ? [option.source, baseFacts].filter(Boolean).join(" · ")
      : baseFacts;
  const canStar = !isEmpty && !option.typed && !option.adds;

  if (isEmpty) {
    return (
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys pick through the combobox's aria-activedescendant
      <div
        id={props.id}
        role="option"
        aria-selected={props.chosen}
        tabIndex={-1}
        data-highlighted={props.highlighted ? "" : undefined}
        onMouseMove={props.highlighted ? undefined : props.onHighlight}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onPick}
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-ui text-foreground select-none data-highlighted:bg-accent focus-ring-inset"
      >
        <span className="min-w-0 truncate font-medium">{option.name}</span>
        {subtitle && (
          <span className="min-w-0 flex-1 truncate text-right text-xs text-subtle-foreground">
            {subtitle}
          </span>
        )}
        {props.chosen && <CheckIcon aria-hidden size={12} weight="bold" className="shrink-0" />}
      </div>
    );
  }

  return (
    <div role="none" className="group/row relative">
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys pick through the combobox's aria-activedescendant */}
      <div
        id={props.id}
        role="option"
        {...part(
          "menu-item",
          option.cant ? "disabled" : props.chosen ? "checked" : undefined,
          "option",
        )}
        aria-selected={props.chosen}
        aria-disabled={option.cant ? true : undefined}
        data-disabled={option.cant ? "" : undefined}
        data-highlighted={props.highlighted ? "" : undefined}
        tabIndex={-1}
        title={option.cant}
        onMouseMove={props.highlighted ? undefined : props.onHighlight}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onPick}
        className={cn(
          "flex h-11 w-full items-center gap-2 rounded-md px-2.5 text-ui whitespace-nowrap text-foreground select-none data-highlighted:bg-accent data-disabled:opacity-50 focus-ring-inset",
          canStar ? "pr-8" : "pr-2.5",
          !option.cant && "cursor-pointer",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {endpoint && !option.typed && (
              <SpadeModelMark
                model={{ id: props.modelId, name: option.name }}
                account={endpoint}
                size={14}
                className="shrink-0"
                decorative
              />
            )}
            <span className="truncate font-medium">{option.name}</span>
          </span>
          {(subtitle || showCapabilities) && (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-xs leading-4 text-subtle-foreground",
                option.cant && "text-status-failed",
              )}
            >
              {props.mixed && endpoint && (
                <SpadeProviderMark
                  account={endpoint}
                  name={option.source ?? endpoint.name}
                  size={12}
                  className="size-3 shrink-0"
                  decorative
                />
              )}
              {subtitle && <span className="truncate">{subtitle}</span>}
              {subtitle && showCapabilities && <span aria-hidden>·</span>}
              {showCapabilities && modelInfo && (
                <SpadeModelCapabilities capabilities={modelInfo.capabilities} size={12} />
              )}
            </span>
          )}
        </span>
        {props.chosen && <CheckIcon aria-hidden size={12} weight="bold" className="shrink-0" />}
      </div>
      {props.number !== undefined && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-(--motion-fast) group-hover/row:opacity-100",
            canStar ? (props.chosen ? "right-12" : "right-8") : "right-2.5",
            revealed && "opacity-100",
          )}
        >
          <Kbd
            keys={`mod+${props.number}`}
            variant="bare"
            className="bg-transparent tabular-nums"
          />
        </span>
      )}
      {canStar && (
        <Tip label={`${props.starred ? "Remove from" : "Add to"} favorites`}>
          <button
            type="button"
            aria-label={`${props.starred ? "Remove" : "Add"} ${option.name} ${props.starred ? "from" : "to"} favorites`}
            aria-pressed={props.starred}
            tabIndex={props.highlighted ? 0 : -1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onStar}
            className={cn(
              "absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-subtle-foreground opacity-0 transition-[color,opacity] duration-(--motion-fast) group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-ring-inset aria-pressed:text-link pointer-coarse:opacity-100",
              (revealed || props.starred) && "opacity-100",
            )}
          >
            <StarIcon aria-hidden size={14} weight={props.starred ? "fill" : "regular"} />
          </button>
        </Tip>
      )}
    </div>
  );
}

function EmptyPanel(props: { icon: "star" | "search"; title: string; hint: string }) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center"
    >
      {props.icon === "star" ? (
        <StarIcon aria-hidden size={20} className="mb-1 text-subtle-foreground" />
      ) : (
        <MagnifyingGlassIcon aria-hidden size={20} className="mb-1 text-subtle-foreground" />
      )}
      <p className="text-ui text-foreground">{props.title}</p>
      <p className="text-xs text-subtle-foreground">{props.hint}</p>
    </div>
  );
}
