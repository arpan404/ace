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
  type PickerTab,
} from "@ace/ui-core";
import { ArrowClockwiseIcon, MagnifyingGlassIcon, StarIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useModelInstances, type CatalogState } from "@/lib/model-catalog.ts";
import { useFavoriteModels } from "./favorites.ts";
import { GroupHeader, GroupProblem, LegacyToggle, ModelRow } from "./model-picker-rows.tsx";
import { useRefreshModels } from "./use-refresh-models.ts";

/** ⌘1…⌘9 pick the first rows. */
const numbered = 9;

/**
 * The panel's height, reserved from the moment it opens: loading rows, the catalog arriving or
 * refreshing, another tab, a search or a new star never move the search field or the list.
 * Longer lists scroll; the viewport can still make it shorter.
 */
const panelHeight = 480;

const tabButton =
  "grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-selected:bg-foreground/8 aria-selected:text-foreground data-disabled:opacity-40";

/** One row the arrows move through: a model, or a group's Legacy models row. */
type Item =
  | { kind: "model"; model: PickerModel; group: PickerGroup | undefined }
  | { kind: "legacy"; group: PickerGroup; expanded: boolean };

/**
 * Pick a model: Favorites and one tab per provider down the left, a search over every provider
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
  // Until a tab is chosen the picker follows the current model's provider, so a catalog that
  // arrives after the picker opened still lands there.
  const [chosen, setChosen] = useState<PickerTab>();
  const open = providers.filter((entry) => !entry.reason);
  const tab: PickerTab =
    props.only ??
    chosen ??
    (props.currentProvider && open.some((entry) => entry.provider === props.currentProvider)
      ? props.currentProvider
      : favorites.length
        ? "favorites"
        : (open[0]?.provider ?? "favorites"));
  const [query, setQuery] = useState("");
  const scoped = props.only
    ? props.models.filter((model) => model.provider === props.only)
    : props.models;
  // A search and Favorites mix providers: one row per model, each saying whose it is.
  const mixed = query.trim() !== "" || tab === "favorites";
  // Each account lists its own rows; a search or Favorites lists each model once.
  const isCurrent = (model: PickerModel) =>
    model.key === props.current &&
    (mixed ||
      !props.currentInstance ||
      !model.instance ||
      model.instance === props.currentInstance);
  // Legacy models open where the current model is one of them, until the person toggles them.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const expanded = (group: PickerGroup) => toggled.get(group.id) ?? group.legacy.some(isCurrent);
  const groups = mixed ? [] : pickerGroups(scoped, instances, tab, accounts.data ?? []);
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
  // Keyboard moves keep the highlighted row in view inside the scrolling list.
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [listId, active]);
  const tabs: { id: PickerTab; reason: string | undefined }[] = props.only
    ? []
    : [
        { id: "favorites", reason: undefined },
        ...providers.map((entry) => ({ id: entry.provider, reason: entry.reason })),
      ];
  const loading = props.catalog === "loading" && !props.models.length;

  const pick = (model: PickerModel | undefined) => {
    // Where accounts don't matter (a search, Favorites) the thread keeps its own account.
    if (model && !model.unavailable) props.onPick(model.key, mixed ? undefined : model.instance);
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
  const showTab = (next: PickerTab) => {
    setChosen(next);
    setQuery("");
    setHighlight(0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
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
    if (!items.length) return;
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
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const usable = tabs.filter((entry) => !entry.reason);
    const at = usable.findIndex((entry) => entry.id === tab);
    const next =
      usable[(at + (event.key === "ArrowDown" ? 1 : -1) + usable.length) % usable.length];
    if (!next) return;
    showTab(next.id);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
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
        aria-label={group.label ?? providerNames[group.provider]}
        aria-describedby={problemIds.join(" ") || undefined}
        aria-busy={group.refreshing || undefined}
      >
        <GroupHeader group={group} />
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
      onKeyDown={onKeyDown}
      className="flex w-[min(440px,calc(100vw-2rem))]"
      style={{ height: `min(${panelHeight}px, var(--available-height, ${panelHeight}px))` }}
    >
      {tabs.length > 0 && (
        <div
          role="tablist"
          aria-label="Model sources"
          aria-orientation="vertical"
          onKeyDown={onTabKey}
          className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border py-2"
        >
          {tabs.map((entry) => {
            const name = entry.id === "favorites" ? "Favorites" : providerNames[entry.id];
            const selected = !query && tab === entry.id;
            return (
              <Tip key={entry.id} label={entry.reason ?? name} side="left">
                <button
                  type="button"
                  role="tab"
                  data-tab={entry.id}
                  aria-label={name}
                  aria-selected={selected}
                  aria-disabled={entry.reason ? true : undefined}
                  data-disabled={entry.reason ? "" : undefined}
                  aria-controls={listId}
                  tabIndex={tab === entry.id ? 0 : -1}
                  onClick={() => {
                    if (!entry.reason) showTab(entry.id);
                  }}
                  className={tabButton}
                >
                  {entry.id === "favorites" ? (
                    <StarIcon aria-hidden size={16} weight={selected ? "fill" : "regular"} />
                  ) : (
                    <ProviderIcon provider={entry.id} size={16} decorative />
                  )}
                </button>
              </Tip>
            );
          })}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3 text-subtle-foreground">
          <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0" />
          <input
            ref={search}
            autoFocus
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
              refresh.refresh(props.only ?? (tab === "favorites" || mixed ? undefined : tab))
            }
          />
        </div>
        <div
          role="listbox"
          id={listId}
          aria-label="Models"
          aria-busy={loading || undefined}
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
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
              <Empty query={query} favorites={tab === "favorites"} />
            ))}
        </div>
      </div>
    </div>
  );
}

/** What an empty list says: nothing matched, nothing starred yet, or nothing listed. */
function Empty(props: { query: string; favorites: boolean }) {
  const [title, hint] = props.query.trim()
    ? [`No models match “${props.query}”`, "Search looks across every provider"]
    : props.favorites
      ? ["No favorites yet", "Star a model to keep it here"]
      : ["No models", "This provider lists no models yet"];
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center"
    >
      {props.favorites && !props.query.trim() ? (
        <StarIcon aria-hidden size={20} className="mb-1 text-subtle-foreground" />
      ) : (
        <MagnifyingGlassIcon aria-hidden size={20} className="mb-1 text-subtle-foreground" />
      )}
      <p className="text-ui text-foreground">{title}</p>
      <p className="text-xs text-subtle-foreground">{hint}</p>
    </div>
  );
}
