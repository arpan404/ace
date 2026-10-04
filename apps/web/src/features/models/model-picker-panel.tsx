import type { ProviderKind } from "@ace/protocol";
import {
  pickerList,
  providerNames,
  type PickerModel,
  type PickerProvider,
  type PickerTab,
} from "@ace/ui-core";
import { MagnifyingGlassIcon, StarIcon } from "@phosphor-icons/react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Kbd } from "@/components/ui/kbd.tsx";
import { menuItem, menuLabel } from "@/components/ui/menu-styles.ts";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useFavoriteModels } from "./favorites.ts";

/** ⌘1…⌘9 pick the first rows. */
const numbered = 9;

const tabButton =
  "grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-selected:bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)] aria-selected:text-foreground data-disabled:opacity-40";

/**
 * Pick a model: Favorites and one tab per provider down the left, a search over every
 * provider on top, and the models of the tab (or the search) with ⌘1…⌘9 on the first rows and
 * a star to favorite. Arrows move through the list from the search field; Enter picks.
 */
export function ModelPickerPanel(props: {
  models: readonly PickerModel[];
  providers: readonly PickerProvider[];
  current: string | undefined;
  currentProvider: ProviderKind | undefined;
  onPick(key: string): void;
}) {
  const { favorites, toggle } = useFavoriteModels();
  const open = props.providers.filter((entry) => !entry.reason);
  const [tab, setTab] = useState<PickerTab>(() =>
    props.currentProvider && open.some((entry) => entry.provider === props.currentProvider)
      ? props.currentProvider
      : favorites.length
        ? "favorites"
        : (open[0]?.provider ?? "favorites"),
  );
  const [query, setQuery] = useState("");
  const list = pickerList(props.models, { tab, query, favorites });
  const rows = list.rows;
  const [highlight, setHighlight] = useState(() =>
    Math.max(
      0,
      rows.findIndex((row) => row.key === props.current),
    ),
  );
  const active = Math.min(highlight, Math.max(0, rows.length - 1));
  const listId = useId();
  // Keyboard moves keep the highlighted row in view inside the scrolling list.
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [listId, active]);
  const tabs: { id: PickerTab; reason: string | undefined }[] = [
    { id: "favorites", reason: undefined },
    ...props.providers.map((entry) => ({ id: entry.provider, reason: entry.reason })),
  ];

  const pick = (row: PickerModel | undefined) => {
    if (row && !row.unavailable) props.onPick(row.key);
  };
  const showTab = (next: PickerTab) => {
    setTab(next);
    setQuery("");
    setHighlight(0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
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
    return (
      <div key={model.key} role="none" className="relative">
        <div
          role="option"
          id={`${listId}-${index}`}
          aria-selected={model.key === props.current}
          aria-disabled={model.unavailable ? true : undefined}
          data-disabled={model.unavailable ? "" : undefined}
          aria-label={`${model.label}, ${providerNames[model.provider]}`}
          data-highlighted={index === active ? "" : undefined}
          onMouseMove={() => setHighlight(index)}
          onClick={() => pick(model)}
          className={cn(menuItem, "h-auto min-h-[42px] items-center py-1.5 pr-12")}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{model.label}</span>
              {model.isNew && (
                <span className="rounded-xs bg-secondary px-1 text-2xs font-medium tracking-[0.02em] text-foreground">
                  NEW
                </span>
              )}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-subtle-foreground">
              <ProviderIcon provider={model.provider} size={12} decorative />
              <span className="truncate">
                {providerNames[model.provider]}
                {model.unavailable && ` · ${model.unavailable}`}
              </span>
            </span>
          </span>
          {index < numbered && <Kbd keys={`mod+${index + 1}`} />}
        </div>
        <button
          type="button"
          aria-label={`${starred ? "Remove" : "Add"} ${model.label} ${starred ? "from" : "to"} favorites`}
          aria-pressed={starred}
          tabIndex={index === active ? 0 : -1}
          onClick={() => toggle(model.key)}
          className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-subtle-foreground outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-pressed:text-foreground"
        >
          <StarIcon aria-hidden size={14} weight={starred ? "fill" : "regular"} />
        </button>
      </div>
    );
  };

  return (
    <div
      onKeyDown={onKeyDown}
      className="flex w-[min(420px,calc(100vw-2rem))]"
      style={{ height: "min(360px, var(--available-height, 360px))" }}
    >
      <div
        role="tablist"
        aria-label="Model sources"
        aria-orientation="vertical"
        onKeyDown={onTabKey}
        className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border py-2"
      >
        {tabs.map((entry) => {
          const name = entry.id === "favorites" ? "Favorites" : providerNames[entry.id];
          return (
            <Tip key={entry.id} label={entry.reason ?? name} side="left">
              <button
                type="button"
                role="tab"
                data-tab={entry.id}
                aria-label={name}
                aria-selected={!query && tab === entry.id}
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
                  <StarIcon aria-hidden size={16} weight="fill" />
                ) : (
                  <ProviderIcon provider={entry.id} size={16} decorative />
                )}
              </button>
            </Tip>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <label className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-subtle-foreground">
          <MagnifyingGlassIcon aria-hidden size={14} />
          <input
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
        </label>
        <div
          role="listbox"
          id={listId}
          aria-label="Models"
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
          {!rows.length && (
            <p role="status" className="px-2.5 py-6 text-center text-xs text-subtle-foreground">
              {query
                ? `No models match “${query}”`
                : tab === "favorites"
                  ? "Star a model to keep it here"
                  : "No models"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
