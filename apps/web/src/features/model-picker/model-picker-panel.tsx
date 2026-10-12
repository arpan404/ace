import { useAccountViews } from "@/lib/account-views.ts";
import type { ProviderKind } from "@ace/protocol";
import {
  pickerGroups,
  pickerList,
  providerNames,
  providersWithProblems,
  type PickerGroup,
  type PickerModel,
  type PickerProvider,
} from "@ace/ui-core";
import { ArrowClockwiseIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useMemo,
  useCallback,
  type KeyboardEvent,
} from "react";
import { VirtualPickerRows, type PickerItem } from "./virtual-picker-rows.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { PickerRail } from "./picker-rail.tsx";
import { pickerEntries, railGroups } from "./picker-entries.ts";
import { useNow } from "@/lib/time.ts";
import { formatResetCountdown } from "@/features/accounts/index.ts";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useModelInstances, type CatalogState } from "@/lib/model-catalog.ts";
import { useFavoriteModels } from "./favorites.ts";
import { AccountSwitch } from "./account-switch.tsx";
import { GroupProblem, LegacyToggle, ModelRow, PickerEmpty } from "./model-picker-rows.tsx";
import { useRefreshModels } from "./use-refresh-models.ts";

/** ⌘1…⌘9 pick the first rows. */
const numbered = 9;

/** The panel follows its content up to this height, then its list scrolls. */
const panelHeight = 360;

/**
 * Pick a model: Favorites and one tab per provider down the left (its accounts switched in the
 * list's header), a search over every provider on top with Refresh models, and the tab's models
 * by source (each account, local runtimes,
 * OpenCode Go and Zen, the person's own API keys), current models first and older ones under
 * each group's Legacy models. Each group says when it is refreshing or couldn't be refreshed.
 * ⌘1…⌘9 pick the first rows, a check marks the current one, a star favorites. Arrows move from
 * the search field, → and ← open and close Legacy models, Enter picks; Escape closes the popover.
 */
export function ModelPickerPanel(props: {
  models: readonly PickerModel[];
  providers: readonly PickerProvider[];
  /** The chosen model's key, and the account it runs on when known. */
  current: string | undefined;
  currentInstance?: string | undefined;
  currentProvider: ProviderKind | undefined;
  catalog: CatalogState;
  /** One provider's models alone, without the column or Favorites (Settings, automations). */
  only?: ProviderKind | undefined;
  /** A model by key, with the account (instance) its row is on where the row names one. */
  onPick(key: string, instance: string | undefined): void;
  onClose?(): void;
}) {
  const { favorites, toggle: star } = useFavoriteModels();
  const instances = useModelInstances();
  const accounts = useAccountViews();
  const refresh = useRefreshModels();
  // A provider whose discovery failed keeps its tab open, to say why it has nothing to pick.
  const troubled = useMemo(() => providersWithProblems(instances), [instances]);
  const providers = useMemo(
    () =>
      props.providers.map((entry) =>
        entry.reason && troubled.has(entry.provider) ? { ...entry, reason: undefined } : entry,
      ),
    [props.providers, troubled],
  );
  const now = useNow();
  // Settings and automations choose a provider model without routing it to an account.
  const providerOnly = useMemo(
    () => props.only && !props.models.some((model) => model.instance !== undefined),
    [props.only, props.models],
  );
  const entries = useMemo(
    () =>
      pickerEntries(
        providers,
        props.models,
        providerOnly ? [] : (accounts.data ?? []),
        now,
        (at) =>
          `Limit reached${at === undefined ? " · reset time unknown" : ` · ${formatResetCountdown(at, now)}`}`,
      ),
    [providers, props.models, providerOnly, accounts.data, now],
  );
  const tabs = props.only ? entries.filter((entry) => entry.provider === props.only) : entries;
  const [chosen, setChosen] = useState<string>();
  const selected =
    tabs.find((entry) => entry.id === chosen) ??
    tabs.find(
      (entry) =>
        entry.provider === props.currentProvider && entry.instance === props.currentInstance,
    ) ??
    tabs.find((entry) => entry.provider === (props.only ?? props.currentProvider)) ??
    tabs.find((entry) => !entry.reason);
  const tab = selected?.id ?? "favorites";
  const railTabs = useMemo(() => railGroups(tabs), [tabs]);
  const railGroup =
    railTabs.find((group) => group.accounts.some((entry) => entry.id === tab)) ?? railTabs[0];
  const railTab = railGroup?.id ?? "favorites";
  // A provider's tab opens on the account the model runs on, else its first usable one.
  const showGroup = (id: string) => {
    const group = railTabs.find((candidate) => candidate.id === id);
    const entry =
      group?.accounts.find(
        (candidate) =>
          candidate.provider === props.currentProvider &&
          candidate.instance === props.currentInstance,
      ) ??
      group?.accounts.find((candidate) => !candidate.reason) ??
      group?.accounts[0];
    if (entry) showTab(entry.id);
  };
  const provider = selected?.provider;
  const selectedInstance = selected?.instance;
  const [query, setQuery] = useState("");
  const scoped = useMemo(
    () =>
      props.only ? props.models.filter((model) => model.provider === props.only) : props.models,
    [props.only, props.models],
  );
  // Search and Favorites mix providers, so each row names its account.
  const mixed = query.trim() !== "" || tab === "favorites";
  // Search lists each account’s rows; Favorites prefers the current account.
  const currentKey = props.current;
  const currentAccount = props.currentInstance;
  const isCurrent = useCallback(
    (model: PickerModel) =>
      model.key === currentKey &&
      (!currentAccount || !model.instance || model.instance === currentAccount),
    [currentKey, currentAccount],
  );
  // Legacy models open where the current model is one of them, until the person toggles them.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const expanded = useCallback(
    (group: PickerGroup) => toggled.get(group.id) ?? group.legacy.some(isCurrent),
    [toggled, isCurrent],
  );
  const groups = useMemo(
    () =>
      mixed || !provider
        ? []
        : pickerGroups(
            scoped.filter((model) => !selectedInstance || model.instance === selectedInstance),
            instances.filter((status) => !selectedInstance || status.instance === selectedInstance),
            provider,
            accounts.data ?? [],
          ),
    [mixed, provider, scoped, selectedInstance, instances, accounts.data],
  );

  const items: PickerItem[] = useMemo(
    () =>
      mixed
        ? pickerList(scoped, { query, favorites, instance: props.currentInstance }).rows.map(
            (model) => ({ kind: "model", model, group: undefined }),
          )
        : groups.flatMap((group): PickerItem[] => {
            const shown = expanded(group);
            return [
              ...group.current.map((model): PickerItem => ({ kind: "model", model, group })),
              ...(group.legacy.length ? [{ kind: "legacy" as const, group, expanded: shown }] : []),
              ...(shown
                ? group.legacy.map((model): PickerItem => ({ kind: "model", model, group }))
                : []),
            ];
          }),
    [mixed, scoped, query, favorites, props.currentInstance, groups, expanded],
  );
  const models = useMemo(
    () => items.flatMap((item) => (item.kind === "model" ? [item.model] : [])),
    [items],
  );
  // Where each row sits among the items, and among the models (for its ⌘ number).
  const itemAt = useMemo(
    () =>
      new Map(
        items.map(
          (item, index) => [item.kind === "model" ? item.model : item.group, index] as const,
        ),
      ),
    [items],
  );
  const modelAt = useMemo(() => new Map(models.map((model, index) => [model, index])), [models]);
  // Likewise the highlight starts on the current model until the person moves it.
  const [highlight, setHighlight] = useState<number>();
  const start = useMemo(
    () =>
      Math.max(
        0,
        items.findIndex((item) => item.kind === "model" && isCurrent(item.model)),
      ),
    [items, isCurrent],
  );
  const active = Math.min(highlight ?? start, Math.max(0, items.length - 1));
  const listId = useId();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => search.current?.focus({ preventScroll: true }), []);
  // Keyboard moves keep the highlighted row in view inside the scrolling list.
  useEffect(() => {
    const pane = list.current;
    const row = document.getElementById(`${listId}-${active}`);
    if (!pane || !row) return;
    const bounds = pane.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < bounds.top) pane.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) pane.scrollTop += item.bottom - bounds.bottom;
  }, [listId, active]);
  const loading = props.catalog === "loading" && !props.models.length;

  const pick = (model: PickerModel | undefined) => {
    // Every row carries its account, including search results and Favorites.
    if (model && !model.unavailable && (mixed || !selected?.reason))
      props.onPick(model.key, model.instance);
  };
  const setOpen = (group: PickerGroup, shown: boolean, at: number) => {
    setToggled((before) => new Map(before).set(group.id, shown));
    setHighlight(at);
  };
  const activate = (index: number) => {
    const item = items[index];
    if (item?.kind === "model") pick(item.model);
    else if (item) setOpen(item.group, !item.expanded, item.expanded ? index : index + 1);
  };
  const showTab = (next: string) => {
    setChosen(next);
    setQuery("");
    setHighlight(0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      (event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey)) &&
      event.target === search.current &&
      (event.key === "Tab" ||
        (!(items[active]?.kind === "legacy" && items[active]?.expanded) &&
          !(items[active]?.kind === "model" && items[active]?.model.legacy)))
    ) {
      event.preventDefault();
      rail.current?.querySelector<HTMLElement>(`[data-tab="${railTab}"]`)?.focus();
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
      pick(models[Number(event.key) - 1]);
    }
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!items.length || event.defaultPrevented) return;
    const item = items[active];
    const input = event.currentTarget;
    const atEnd = input.selectionStart === input.value.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(active);
    } else if (event.key === "ArrowRight" && atEnd && item?.kind === "legacy" && !item.expanded) {
      event.preventDefault();
      activate(active);
    } else if (event.key === "ArrowLeft" && input.selectionStart === 0 && item?.group) {
      // ← from an older model, or from an open Legacy models row, closes the section on it.
      const toggleAt = itemAt.get(item.group) ?? -1;
      const inside = item.kind === "legacy" ? item.expanded : item.model.legacy;
      if (toggleAt < 0 || !inside) return;
      event.preventDefault();
      setOpen(item.group, false, toggleAt);
    }
  };

  const row = (item: PickerItem, index: number, nested: boolean, section?: number) => {
    const id = `${listId}-${index}`;
    if (item.kind === "legacy")
      return (
        <LegacyToggle
          key={`${item.group.id}-legacy`}
          id={id}
          count={item.group.legacy.length}
          expanded={item.expanded}
          highlighted={index === active}
          // Only the nonvirtual list mounts a single region for this section.
          controls={
            item.expanded && section !== undefined ? `${listId}-legacy-${section}` : undefined
          }
          onHighlight={() => setHighlight(index)}
          onToggle={() => activate(index)}
        />
      );
    const number = modelAt.get(item.model) ?? -1;
    return (
      <ModelRow
        key={`${item.model.instance ?? ""}-${item.model.key}`}
        model={item.model}
        id={id}
        mixed={mixed}
        current={isCurrent(item.model)}
        highlighted={index === active}
        starred={favorites.includes(item.model.key)}
        number={number >= 0 && number < numbered ? number + 1 : undefined}
        nested={nested}
        onHighlight={() => setHighlight(index)}
        onPick={() => pick(item.model)}
        onStar={() => star(item.model.key)}
      />
    );
  };
  // Each group's rows, its legacy ones in their own labelled group under its toggle.
  const sections =
    items.length > 60
      ? []
      : groups.map((group, section) => {
          const at = (model: PickerModel) => itemAt.get(model) ?? -1;
          const toggleAt = itemAt.get(group) ?? -1;
          const problemIds = group.problems.map(
            (_, index) => `${listId}-problem-${section}-${index}`,
          );
          const legacyRow = items[toggleAt];
          return (
            <div
              key={group.id}
              role="group"
              aria-label={
                group.label ??
                accounts.data?.find((account) => account.id === selected?.instance)?.label ??
                providerNames[group.provider]
              }
              aria-describedby={problemIds.join(" ") || undefined}
              aria-busy={group.refreshing || undefined}
            >
              {group.problems.map((problem, index) => (
                <GroupProblem
                  key={problem.message}
                  problem={problem}
                  id={problemIds[index] ?? ""}
                  provider={group.provider}
                />
              ))}
              {group.current.map((model) => row({ kind: "model", model, group }, at(model), false))}
              {legacyRow && row(legacyRow, toggleAt, false, section)}
              {legacyRow?.kind === "legacy" && legacyRow.expanded && (
                <div role="group" id={`${listId}-legacy-${section}`} aria-label="Legacy models">
                  {group.legacy.map((model) =>
                    row({ kind: "model", model, group }, at(model), true),
                  )}
                </div>
              )}
            </div>
          );
        });
  const legacyFrom = useMemo(
    () => (mixed ? models.findIndex((model) => model.legacy) : -1),
    [mixed, models],
  );

  return (
    <div
      data-slot="model-picker"
      onKeyDownCapture={onKeyDown}
      className="flex w-88 max-w-[calc(100vw-2rem)]"
      style={{ maxHeight: `min(${panelHeight}px, var(--available-height, ${panelHeight}px))` }}
    >
      <PickerRail
        groups={railTabs}
        selected={railTab}
        searching={!!query}
        listId={listId}
        ref={rail}
        focusList={() => search.current?.focus()}
        onSelect={showGroup}
      />
      <div
        role="tabpanel"
        id={`${listId}-pane`}
        aria-label={mixed ? "Search results and favorites" : (selected?.name ?? "Models")}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <div className="mx-2 flex h-8 shrink-0 items-center gap-2 border-b border-border text-subtle-foreground focus-within:border-ring">
          <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0" />
          <input
            ref={search}
            role="combobox"
            aria-label="Search models"
            aria-controls={listId}
            aria-expanded
            aria-activedescendant={items.length ? `${listId}-${active}` : undefined}
            value={query}
            placeholder="Search models…"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onSearchKey}
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none focus-visible:placeholder:text-muted-foreground placeholder:text-subtle-foreground"
          />
          {(props.catalog === "refreshing" || refresh.pending) && (
            <Spinner label="Refreshing models" />
          )}
          <IconButton
            icon={ArrowClockwiseIcon}
            label="Refresh models"
            size="sm"
            disabled={refresh.pending || refresh.reason !== undefined}
            reason={refresh.reason ?? (refresh.pending ? "Refreshing models…" : undefined)}
            onClick={() =>
              refresh.refresh(mixed ? undefined : provider, mixed ? undefined : selected?.instance)
            }
          />
        </div>
        {!mixed && railGroup && railGroup.accounts.length > 1 && (
          <AccountSwitch
            accounts={railGroup.accounts}
            selected={tab}
            listId={listId}
            onSelect={showTab}
          />
        )}
        <div
          ref={list}
          role="listbox"
          id={listId}
          aria-label="Models"
          aria-busy={loading || undefined}
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1 [scrollbar-width:thin]"
        >
          {!mixed && selected?.reason && (
            <p role="status" className="px-2.5 py-2 text-xs text-status-limited">
              {selected.reason}
            </p>
          )}
          {items.length > 60 ? (
            <VirtualPickerRows
              items={items}
              groups={groups}
              active={active}
              list={list}
              listId={listId}
              renderRow={(item, index) => row(item, index, false)}
            />
          ) : mixed ? (
            <>
              {models
                .slice(0, legacyFrom < 0 ? undefined : legacyFrom)
                .map((model, index) =>
                  row({ kind: "model", model, group: undefined }, index, false),
                )}
              {legacyFrom >= 0 && (
                <div role="group" aria-label="Legacy models">
                  {models
                    .slice(legacyFrom)
                    .map((model, at) =>
                      row({ kind: "model", model, group: undefined }, legacyFrom + at, false),
                    )}
                </div>
              )}
            </>
          ) : (
            sections
          )}
          {!items.length &&
            !groups.some((group) => group.problems.length) &&
            (loading ? (
              <LoadingRegion label="models" className="flex flex-col">
                {[72, 56, 64, 48].map((width, at) => (
                  <span key={width} className="flex h-8 items-center px-2.5">
                    <Skeleton style={{ width: `${width}%`, animationDelay: `${at * 70}ms` }} />
                  </span>
                ))}
              </LoadingRegion>
            ) : (
              <PickerEmpty query={query} favorites={tab === "favorites"} />
            ))}
        </div>
      </div>
    </div>
  );
}
