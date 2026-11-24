import {
  spadeAccountLabels,
  spadeAccountState,
  spadeLocalFirst,
  spadeModelGroups,
  type SpadeEndpoint,
  type SpadeModelInfo,
  type SpadeModelOption,
  type SpadeModelSources,
} from "@ace/ui-core/spade-chat";
import { ArrowClockwiseIcon, DesktopIcon, MagnifyingGlassIcon, StarIcon } from "@ace/icons";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { numberedChoice, PickerRail } from "@/features/model-picker/index.ts";
import { favoriteAccount, useSpadeFavorites } from "./spade-model-favorites.ts";
import { SpadePickerEmpty, SpadePickerRow } from "./spade-model-picker-row.tsx";
import { SpadeProviderMark } from "./spade-marks.tsx";
import { useSpadeMachine } from "./spade-machine.tsx";

const panelHeight = 360;
const numbered = 9;
const localTabId = "__local__";
const favoritesTabId = "__favorites__";

interface RailTab {
  id: string;
  name: string;
  kind: "favorites" | "endpoint" | "local";
  endpoint?: SpadeEndpoint | undefined;
  /** Shown as a tiny corner badge when a provider has multiple accounts. */
  badge?: string | undefined;
  reason?: string | undefined;
  tone?: ReturnType<typeof spadeAccountState>["tone"] | undefined;
}

function accountBadge(endpoint: SpadeEndpoint): string {
  const trimmed = endpoint.name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "•";
}

/** Spade's own rail marks: a star, the desktop, or the account's provider mark with its badge. */
function RailMark(props: { tab: RailTab; selected: boolean }) {
  if (props.tab.kind === "favorites")
    return <StarIcon aria-hidden size={16} weight={props.selected ? "fill" : "regular"} />;
  if (props.tab.kind === "local") return <DesktopIcon aria-hidden size={16} />;
  const endpoint = props.tab.endpoint;
  if (!endpoint) return null;
  return (
    <span className="relative inline-flex items-center justify-center">
      <SpadeProviderMark account={endpoint} name={props.tab.name} size={16} decorative />
      {props.tab.badge && (
        <span
          aria-hidden
          className="absolute -right-1.5 -bottom-1 grid size-3 place-items-center rounded-full bg-popover text-[8px] leading-none font-semibold text-foreground ring-1 ring-border"
        >
          {props.tab.badge}
        </span>
      )}
    </span>
  );
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
  const machine = useSpadeMachine().key;
  const { values: favoriteValues, isFavorite, toggle: toggleFavorite } = useSpadeFavorites(machine);
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
      out.push({ id: favoritesTabId, name: "Favorites", kind: "favorites" });
    }
    for (const { endpoint } of orderedEndpoints) {
      const state = spadeAccountState(endpoint, props.keychain, props.now);
      const name = labels.get(endpoint.id) ?? endpoint.name;
      const groupKey = endpoint.provider ?? endpoint.id;
      const multiple = (providerCounts.get(groupKey) ?? 0) > 1;
      out.push({
        id: endpoint.id,
        name,
        kind: "endpoint",
        endpoint,
        badge: multiple ? accountBadge(endpoint) : undefined,
        reason: state.tone !== "ready" ? state.text : undefined,
        tone: state.tone,
      });
    }
    if ((props.sources.adds?.length ?? 0) > 0) {
      out.push({ id: localTabId, name: "On this computer", kind: "local" });
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
    if (favoriteValues.length > 0 && tabs.some((tab) => tab.id === favoritesTabId)) {
      return favoritesTabId;
    }
    const firstReady = tabs.find((tab) => tab.kind === "endpoint" && !tab.reason);
    if (firstReady) return firstReady.id;
    const firstSource = tabs.find((tab) => tab.kind !== "favorites");
    return firstSource?.id ?? favoritesTabId;
  }, [props.only, orderedEndpoints, currentEndpointId, tabs, favoriteValues.length]);

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
      const favSet = new Set(favoriteValues);
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
  }, [props.only, searching, allGroups, isFavorites, favoriteValues, activeTabId, labels]);

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
      // Only take Shift+Tab when the rail has a tab to land on; otherwise focus moves on.
      const destination = railRef.current?.querySelector<HTMLElement>(
        `[data-tab="${activeTabId}"]`,
      );
      if (!destination) return;
      event.preventDefault();
      destination.focus();
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
      const quick = numberedChoice(usableModels, event.key);
      if (quick) pickOption(quick);
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

  const nothing = props.sources.endpoints.length === 0 && !props.sources.adds?.length;
  // Rows a key or a number can act on: the empty choice, typed ids and models that can't run
  // here have no slot. Badges and ⌘1–9 both read this one list.
  const usableModels = flat.filter(
    (option) => option.value !== "" && !option.typed && !option.cant,
  );
  const modelNumber = new Map(usableModels.map((option, idx) => [option.value, idx + 1]));

  return (
    <div
      data-slot="model-picker"
      onKeyDownCapture={onPanelKeyDown}
      className="flex w-96 max-w-[calc(100vw-2rem)]"
      style={{ height: `min(${panelHeight}px, var(--available-height, ${panelHeight}px))` }}
    >
      <PickerRail
        entries={tabs}
        selected={activeTabId}
        searching={searching}
        listId={listId}
        ref={railRef}
        focusList={() => searchRef.current?.focus()}
        onSelect={selectTab}
        renderMark={(tab, selected) => <RailMark tab={tab} selected={selected} />}
      />

      <div
        role="tabpanel"
        id={`${listId}-pane`}
        aria-label={mixed ? "Search results and favorites" : (activeTab?.name ?? "Models")}
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
                const account = favoriteAccount(endpoint);
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
                    starred={!isEmpty && !option.typed && isFavorite(account, option.value)}
                    number={num !== undefined && num <= numbered ? num : undefined}
                    onHighlight={() => setHighlight(index)}
                    onPick={() => pickOption(option)}
                    onStar={() => toggleFavorite(account, option.value)}
                  />
                );
              })}
            </div>
          ))}

          {nothing && (
            <SpadePickerEmpty
              icon="search"
              title="No providers set up"
              hint="Add a provider in Models first"
            />
          )}
          {!nothing && flat.length === 0 && (
            <SpadePickerEmpty
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
