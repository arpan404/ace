import { ArrowLeftIcon, CheckIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { IconButton } from "./icon-button.tsx";
import { Input } from "./input.tsx";
import { menuItem } from "./menu-styles.ts";

/** "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export const cityOf = (zone: string) => (zone.split("/").pop() ?? zone).replaceAll("_", " ");

/**
 * Zones matching a search, best first: a city that starts with the words, then a zone that
 * starts with them, then any zone containing them. Spaces and underscores are the same, so
 * "new york", "new_york" and "york" all find America/New_York. An empty search keeps the order.
 */
export function searchZones(zones: readonly string[], query: string): string[] {
  const words = query.trim().toLowerCase().replaceAll("_", " ");
  if (!words) return [...zones];
  const ranked: [rank: number, zone: string][] = [];
  for (const zone of zones) {
    const name = zone.toLowerCase().replaceAll("_", " ");
    const city = cityOf(zone).toLowerCase();
    const rank = city.startsWith(words)
      ? 0
      : name.startsWith(words)
        ? 1
        : name.includes(words)
          ? 2
          : -1;
    if (rank >= 0) ranked.push([rank, zone]);
  }
  return ranked.toSorted((a, b) => a[0] - b[0]).map(([, zone]) => zone);
}

/**
 * A time zone picked by search, shown in place inside a popup rather than as another popup
 * on top. Arrows move through the matches, Enter picks, Escape goes back.
 */
export function ZoneSearch(props: {
  value: string;
  zones: readonly string[];
  onPick(zone: string): void;
  onBack(): void;
}) {
  const [query, setQuery] = useState("");
  const matches = searchZones(props.zones, query);
  const [active, setActive] = useState(() => Math.max(0, matches.indexOf(props.value)));
  const list = useRef<HTMLDivElement>(null);
  const current = Math.min(active, Math.max(0, matches.length - 1));

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.min(Math.max(current + step, 0), matches.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const zone = matches[current];
      if (zone) props.onPick(zone);
    } else if (event.key === "Escape") {
      // Back to the panel, not out of it.
      event.preventDefault();
      event.stopPropagation();
      props.onBack();
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className="flex items-center gap-1">
        <IconButton icon={ArrowLeftIcon} label="Back" size="sm" onClick={props.onBack} />
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the search is what this view is for
          autoFocus
          role="combobox"
          aria-label="Search time zones"
          aria-expanded
          aria-controls="zone-search-list"
          aria-activedescendant={matches[current] ? `zone-${current}` : undefined}
          value={query}
          placeholder="Search city or zone"
          onValueChange={(next) => {
            setQuery(next);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-7"
        />
      </div>
      <div
        ref={list}
        id="zone-search-list"
        role="listbox"
        aria-label="Time zones"
        className="max-h-[min(16rem,40dvh)] overflow-y-auto overscroll-contain"
      >
        {matches.length === 0 && (
          <p className="px-2 py-1.5 text-ui text-muted-foreground">No zone matches.</p>
        )}
        {matches.map((zone, index) => (
          <button
            key={zone}
            id={`zone-${index}`}
            type="button"
            role="option"
            tabIndex={-1}
            data-index={index}
            aria-selected={zone === props.value}
            data-highlighted={index === current ? "" : undefined}
            onMouseMove={() => setActive(index)}
            onClick={() => props.onPick(zone)}
            className={cn(menuItem, "gap-2")}
          >
            <span className="truncate">{cityOf(zone)}</span>
            <span className="min-w-0 flex-1 truncate text-left text-xs text-subtle-foreground">
              {zone.includes("/") ? zone.slice(0, zone.lastIndexOf("/")).replaceAll("_", " ") : ""}
            </span>
            {zone === props.value && <CheckIcon aria-hidden size={14} />}
          </button>
        ))}
      </div>
    </div>
  );
}
