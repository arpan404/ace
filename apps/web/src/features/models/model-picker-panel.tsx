import type { ProviderKind } from "@ace/protocol";
import {
  pickerList,
  providerNames,
  type PickerModel,
  type PickerProvider,
  type PickerTab,
} from "@ace/ui-core";
import { CheckIcon, MagnifyingGlassIcon, StarIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { menuItem, menuLabel } from "@/components/ui/menu-styles.ts";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { titleWhenClipped } from "@/lib/clipped-title.ts";
import { cn } from "@/lib/cn.ts";
import type { CatalogState } from "./control-view.ts";
import { useFavoriteModels } from "./favorites.ts";

/** ⌘1…⌘9 pick the first rows. */
const numbered = 9;

/**
 * The panel's height, reserved from the moment it opens: loading rows, the catalog arriving or
 * refreshing, another tab, a search or a new star never move the search field or the list.
 * Longer lists scroll; the viewport can still make it shorter.
 */
const panelHeight = 340;

const tabButton =
  "grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-selected:bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)] aria-selected:text-foreground data-disabled:opacity-40";

/**
 * Pick a model: Favorites and one tab per provider down the left, a search over every
 * provider on top, and the models of the tab (or the search) with ⌘1…⌘9 on the first rows, a
 * check on the current one and a star to favorite. Arrows move through the list from the
 * search field; Enter picks; Escape clears a search before it closes the popover.
 */
export function ModelPickerPanel(props: {
  models: readonly PickerModel[];
  providers: readonly PickerProvider[];
  current: string | undefined;
  currentProvider: ProviderKind | undefined;
  catalog: CatalogState;
  onPick(key: string): void;
}) {
  const { favorites, toggle } = useFavoriteModels();
  // Until a tab is chosen the picker follows the current model's provider, so a catalog that
  // arrives after the picker opened still lands there.
  const [chosen, setChosen] = useState<PickerTab>();
  const open = props.providers.filter((entry) => !entry.reason);
  const tab: PickerTab =
    chosen ??
    (props.currentProvider && open.some((entry) => entry.provider === props.currentProvider)
      ? props.currentProvider
      : favorites.length
        ? "favorites"
        : (open[0]?.provider ?? "favorites"));
  const [query, setQuery] = useState("");
  const list = pickerList(props.models, { tab, query, favorites });
  const rows = list.rows;
  // Providers mix in Favorites and in a search: each row then says whose model it is.
  const mixed = tab === "favorites" || query.trim() !== "";
  // Likewise the highlight starts on the current model until the person moves it.
  const [highlight, setHighlight] = useState<number>();
  const start = Math.max(
    0,
    rows.findIndex((row) => row.key === props.current),
  );
  const active = Math.min(highlight ?? start, Math.max(0, rows.length - 1));
  const listId = useId();
  const search = useRef<HTMLInputElement>(null);
  // Keyboard moves keep the highlighted row in view inside the scrolling list.
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [listId, active]);
  const tabs: { id: PickerTab; reason: string | undefined }[] = [
    { id: "favorites", reason: undefined },
    ...props.providers.map((entry) => ({ id: entry.provider, reason: entry.reason })),
  ];
  const loading = props.catalog === "loading" && !props.models.length;

  const pick = (row: PickerModel | undefined) => {
    if (row && !row.unavailable) props.onPick(row.key);
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
      pick(rows[Number(event.key) - 1]);
    }
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!rows.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(rows[active]);
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

  const row = (model: PickerModel, index: number) => {
    const starred = favorites.includes(model.key);
    const current = model.key === props.current;
    const highlighted = index === active;
    const subtitle = mixed || model.unavailable;
    return (
      <div key={model.key} role="none" className="relative">
        <div
          role="option"
          id={`${listId}-${index}`}
          aria-selected={current}
          aria-disabled={model.unavailable ? true : undefined}
          data-disabled={model.unavailable ? "" : undefined}
          aria-label={`${model.label}, ${providerNames[model.provider]}`}
          data-highlighted={highlighted ? "" : undefined}
          onMouseMove={() => setHighlight(index)}
          onClick={() => pick(model)}
          className={cn(
            menuItem,
            "gap-2 pr-9",
            subtitle ? "h-auto min-h-11 py-1.5" : "h-8",
            !model.unavailable && "cursor-pointer",
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn("truncate", current && "font-medium")}
                onPointerEnter={titleWhenClipped(model.label)}
              >
                {model.label}
              </span>
              {model.isNew && (
                <span className="shrink-0 rounded-xs bg-[color-mix(in_oklab,var(--ring)_16%,transparent)] px-1 text-2xs leading-4 font-semibold tracking-[0.02em] text-ring">
                  NEW
                </span>
              )}
            </span>
            {subtitle && (
              <span className="flex min-w-0 items-center gap-1 text-xs text-subtle-foreground">
                {mixed && <ProviderIcon provider={model.provider} size={12} decorative />}
                <span className="truncate">
                  {mixed && providerNames[model.provider]}
                  {mixed && model.unavailable && " · "}
                  {model.unavailable}
                </span>
              </span>
            )}
          </span>
          {current && <CheckIcon aria-hidden size={14} weight="bold" className="shrink-0" />}
          {index < numbered && <Kbd keys={`mod+${index + 1}`} className="tabular-nums" />}
        </div>
        <button
          type="button"
          aria-label={`${starred ? "Remove" : "Add"} ${model.label} ${starred ? "from" : "to"} favorites`}
          aria-pressed={starred}
          tabIndex={highlighted ? 0 : -1}
          onClick={() => toggle(model.key)}
          className={cn(
            "absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-subtle-foreground outline-none transition-[color,opacity] duration-(--dur-1) hover:text-foreground focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-pressed:text-foreground",
            !starred && !highlighted && "opacity-0",
          )}
        >
          <StarIcon aria-hidden size={14} weight={starred ? "fill" : "regular"} />
        </button>
      </div>
    );
  };

  return (
    <div
      data-slot="model-picker"
      onKeyDown={onKeyDown}
      className="flex w-[min(440px,calc(100vw-2rem))]"
      style={{ height: `min(${panelHeight}px, var(--available-height, ${panelHeight}px))` }}
    >
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
      <div className="flex min-w-0 flex-1 flex-col">
        <label className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-subtle-foreground">
          <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0" />
          <input
            ref={search}
            autoFocus
            role="combobox"
            aria-label="Search models"
            aria-controls={listId}
            aria-expanded
            aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
            value={query}
            placeholder="Search models"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onSearchKey}
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground"
          />
          {props.catalog === "refreshing" && <Spinner label="Refreshing models" />}
        </label>
        <div
          role="listbox"
          id={listId}
          aria-label="Models"
          aria-busy={loading || undefined}
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {rows.slice(0, list.legacyFrom).map(row)}
          {list.legacyFrom < rows.length && (
            <div role="group" aria-label="Legacy models">
              <div role="presentation" className={menuLabel}>
                Legacy models
              </div>
              {rows.slice(list.legacyFrom).map((model, at) => row(model, list.legacyFrom + at))}
            </div>
          )}
          {!rows.length &&
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
