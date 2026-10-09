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
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { PickerRail } from "./picker-rail.tsx";
import { pickerEntries } from "./picker-entries.ts";
import { useNow } from "@/lib/time.ts";
import { formatResetCountdown } from "@/features/accounts/index.ts";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useModelInstances, type CatalogState } from "@/lib/model-catalog.ts";
import { useFavoriteModels } from "./favorites.ts";
import {
  GroupHeader,
  GroupProblem,
  LegacyToggle,
  ModelRow,
  PickerEmpty,
} from "./model-picker-rows.tsx";
import { useRefreshModels } from "./use-refresh-models.ts";

/** ⌘1…⌘9 pick the first rows. */
const numbered = 9;

/**
 * The panel's height, reserved from the moment it opens: loading rows, the catalog arriving or
 * refreshing, another tab, a search or a new star never move the search field or the list.
 * Longer lists scroll; the viewport can still make it shorter.
 */
const panelHeight = 360;

/** One row the arrows move through: a model, or a group's Legacy models row. */
type Item =
  | { kind: "model"; model: PickerModel; group: PickerGroup | undefined }
  | { kind: "legacy"; group: PickerGroup; expanded: boolean };

/**
 * Pick a model: Favorites and one entry per account down the left, a search over every provider
 * on top with Refresh models, and the tab's models by source (each account, local runtimes,
 * OpenCode Go and Zen, the person's own API keys), current models first and older ones under
 * each group's Legacy models. Each group says when it is refreshing or couldn't be refreshed.
 * ⌘1…⌘9 pick the first rows, a check marks the current one, a star favorites. Arrows move from
 * the search field, → and ← open and close Legacy models, Enter picks; Escape clears a search
 * before it closes the popover.
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
  const troubled = providersWithProblems(instances);
  const providers = props.providers.map((entry) =>
    entry.reason && troubled.has(entry.provider) ? { ...entry, reason: undefined } : entry,
  );
  const now = useNow();
  // Settings and automations choose a provider model without routing it to an account.
  const providerOnly = props.only && !props.models.some((model) => model.instance !== undefined);
  const entries = pickerEntries(
    providers,
    props.models,
    providerOnly ? [] : (accounts.data ?? []),
    now,
    (at) =>
      `Limit reached${at === undefined ? " · reset time unknown" : ` · ${formatResetCountdown(at, now)}`}`,
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
  const provider = selected?.provider;
  const [query, setQuery] = useState("");
  const scoped = props.only
    ? props.models.filter((model) => model.provider === props.only)
    : props.models;
  // Search and Favorites mix providers, so each row names its account.
  const mixed = query.trim() !== "" || tab === "favorites";
  // Search lists each account’s rows; Favorites prefers the current account.
  const isCurrent = (model: PickerModel) =>
    model.key === props.current &&
    (!props.currentInstance || !model.instance || model.instance === props.currentInstance);
  // Legacy models open where the current model is one of them, until the person toggles them.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const expanded = (group: PickerGroup) => toggled.get(group.id) ?? group.legacy.some(isCurrent);
  const groups =
    mixed || !provider
      ? []
      : pickerGroups(
          scoped.filter((model) => !selected?.instance || model.instance === selected.instance),
          instances.filter(
            (status) => !selected?.instance || status.instance === selected.instance,
          ),
          provider,
          accounts.data ?? [],
        );

  const items: Item[] = mixed
    ? pickerList(scoped, { query, favorites, instance: props.currentInstance }).rows.map(
        (model) => ({ kind: "model", model, group: undefined }),
      )
    : groups.flatMap((group): Item[] => {
        const shown = expanded(group);
        return [
          ...group.current.map((model): Item => ({ kind: "model", model, group })),
          ...(group.legacy.length ? [{ kind: "legacy" as const, group, expanded: shown }] : []),
          ...(shown ? group.legacy.map((model): Item => ({ kind: "model", model, group })) : []),
        ];
      });
  const models = items.flatMap((item) => (item.kind === "model" ? [item.model] : []));
  // Where each row sits among the items, and among the models (for its ⌘ number).
  const itemAt = new Map<PickerModel | PickerGroup, number>();
  items.forEach((item, index) =>
    itemAt.set(item.kind === "model" ? item.model : item.group, index),
  );
  const modelAt = new Map(models.map((model, index) => [model, index]));
  // Likewise the highlight starts on the current model until the person moves it.
  const [highlight, setHighlight] = useState<number>();
  const start = Math.max(
    0,
    items.findIndex((item) => item.kind === "model" && isCurrent(item.model)),
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
      !(items[active]?.kind === "legacy" && items[active]?.expanded) &&
      !(items[active]?.kind === "model" && items[active]?.model.legacy)
    ) {
      event.preventDefault();
      rail.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
      return;
    }
    if (event.key === "Escape" && query) {
      // Wherever focus is in the panel, the first Escape clears the search and goes back to
      // it; the popover closes on the next.
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setHighlight(undefined);
      search.current?.focus();
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

  const row = (item: Item, index: number, nested: boolean, section = 0) => {
    const id = `${listId}-${index}`;
    if (item.kind === "legacy")
      return (
        <LegacyToggle
          key={`${item.group.id}-legacy`}
          id={id}
          count={item.group.legacy.length}
          expanded={item.expanded}
          highlighted={index === active}
          controls={item.expanded ? `${listId}-legacy-${section}` : undefined}
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
  const sections = groups.map((group, section) => {
    const at = (model: PickerModel) => itemAt.get(model) ?? -1;
    const toggleAt = itemAt.get(group) ?? -1;
    const problemIds = group.problems.map((_, index) => `${listId}-problem-${section}-${index}`);
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
        {groups.length > 1 && <GroupHeader group={group} />}
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
            {group.legacy.map((model) => row({ kind: "model", model, group }, at(model), true))}
          </div>
        )}
      </div>
    );
  });
  const legacyFrom = mixed ? models.findIndex((model) => model.legacy) : -1;

  return (
    <div
      data-slot="model-picker"
      onKeyDownCapture={onKeyDown}
      className="flex w-[min(360px,calc(100vw-2rem))]"
      style={{ height: `min(${panelHeight}px, var(--available-height, ${panelHeight}px))` }}
    >
      <PickerRail
        entries={tabs}
        selected={tab}
        searching={!!query}
        provider={provider}
        only={!!props.only}
        listId={listId}
        ref={rail}
        focusList={() => search.current?.focus()}
        onSelect={showTab}
        onClose={props.onClose}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3 text-subtle-foreground">
          <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0" />
          <input
            ref={search}
            role="combobox"
            aria-label="Search models"
            aria-controls={listId}
            aria-expanded
            aria-activedescendant={items.length ? `${listId}-${active}` : undefined}
            value={query}
            placeholder="Search models"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onSearchKey}
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground"
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
        <div
          ref={list}
          role="listbox"
          id={listId}
          aria-label="Models"
          aria-busy={loading || undefined}
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {!mixed && selected?.reason && (
            <p role="status" className="px-2.5 py-2 text-xs text-status-limited">
              {selected.reason}
            </p>
          )}
          {mixed ? (
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
