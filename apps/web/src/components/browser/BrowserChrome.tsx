import {
  Clock3Icon,
  GlobeIcon,
  LoaderCircleIcon,
  PinIcon,
  SearchIcon,
  Settings2Icon,
} from "lucide-react";
import { useEffect, useRef } from "react";

import type { BrowserSearchEngine } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import type { BrowserSuggestion } from "~/lib/browser/history";
import { type BrowserPinnedPage } from "~/lib/browser/pinnedPages";
import { BROWSER_SETTINGS_TAB_TITLE } from "~/lib/browser/session";
import { Button } from "../ui/button";
import { BrowserFavicon } from "./BrowserWebviewSurface";
import { BROWSER_SEARCH_ENGINE_OPTIONS, resolveSuggestionKindLabel } from "~/lib/browser/types";

export function BrowserSettingsPanel(props: {
  browserSearchEngine: BrowserSearchEngine;
  historyCount: number;
  isRepairingStorage: boolean;
  pinnedPages: readonly BrowserPinnedPage[];
  onClearHistory: () => void;
  onExportPinnedPages: () => void;
  onImportPinnedPages: (file: File) => void;
  onOpenPinnedPage: (url: string) => void;
  onRemovePinnedPage: (url: string) => void;
  onRepairStorage: () => void;
  onSelectSearchEngine: (engine: BrowserSearchEngine) => void;
}) {
  const {
    browserSearchEngine,
    historyCount,
    isRepairingStorage,
    pinnedPages,
    onClearHistory,
    onExportPinnedPages,
    onImportPinnedPages,
    onOpenPinnedPage,
    onRemovePinnedPage,
    onRepairStorage,
    onSelectSearchEngine,
  } = props;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border/70 px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Settings2Icon className="size-4 text-muted-foreground" />
          {BROWSER_SETTINGS_TAB_TITLE}
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Search engine, local browser history, and storage repair live here so the address bar can
          stay focused on navigation.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Search engine</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Used for new-tab home pages, search actions, and address-bar suggestions.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {BROWSER_SEARCH_ENGINE_OPTIONS.map((engine) => (
              <Button
                key={engine.value}
                variant={browserSearchEngine === engine.value ? "default" : "outline"}
                size="sm"
                onClick={() => onSelectSearchEngine(engine.value)}
              >
                {engine.label}
              </Button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Pinned pages</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Keep frequently revisited pages at the top of suggestions. Pin the current page from
                the browser toolbar.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) {
                    onImportPinnedPages(file);
                  }
                  event.currentTarget.value = "";
                }}
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                Import
              </Button>
              <Button variant="outline" size="sm" onClick={onExportPinnedPages}>
                Export
              </Button>
            </div>
          </div>
          {pinnedPages.length > 0 ? (
            <div className="space-y-2">
              {pinnedPages.map((page) => (
                <div
                  key={page.url}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/55 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <BrowserFavicon
                      url={page.url}
                      title={page.title}
                      className="size-4"
                      fallbackClassName="size-4 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {page.title}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{page.url}</div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => onOpenPinnedPage(page.url)}>
                      Open
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRemovePinnedPage(page.url)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/80 bg-card/35 px-3 py-4 text-sm text-muted-foreground">
              No pinned pages yet.
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">History</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {historyCount} saved {historyCount === 1 ? "entry" : "entries"}. Suggestions in the
              address bar come from this list first.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onClearHistory}
              disabled={historyCount === 0}
            >
              Clear history
            </Button>
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Repair</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Clears the in-app browser partition, including cookies, cache, and service workers,
              without touching the rest of the app.
            </p>
          </div>
          <Button
            variant="destructive-outline"
            size="sm"
            onClick={onRepairStorage}
            disabled={isRepairingStorage}
          >
            {isRepairingStorage ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
            Repair browser storage
          </Button>
        </section>
      </div>
    </div>
  );
}

export function BrowserSuggestionList(props: {
  activeIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (suggestion: BrowserSuggestion) => void;
  suggestions: readonly BrowserSuggestion[];
}) {
  const { activeIndex, onHighlight, onSelect, suggestions } = props;
  const suggestionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    suggestionItemRefs.current[activeIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [activeIndex]);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className="absolute inset-x-0 top-[calc(100%+0.35rem)] z-20 overflow-hidden rounded-2xl border border-border/80 bg-popover/95 shadow-[0_22px_60px_-28px_color-mix(in_srgb,var(--foreground)_28%,transparent)] backdrop-blur-xl">
      <div className="max-h-80 overflow-y-auto py-1">
        {suggestions.map((suggestion, index) => {
          const isActive = index === activeIndex;
          const icon =
            suggestion.kind === "history" ? (
              <Clock3Icon className="size-4" />
            ) : suggestion.kind === "pinned" ? (
              <PinIcon className="size-4" />
            ) : suggestion.kind === "tab" ? (
              <GlobeIcon className="size-4" />
            ) : (
              <SearchIcon className="size-4" />
            );

          return (
            <button
              key={suggestion.id}
              ref={(element) => {
                suggestionItemRefs.current[index] = element;
              }}
              type="button"
              className={cn(
                "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/60 focus-visible:bg-accent/60",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(suggestion);
              }}
              onMouseEnter={() => {
                onHighlight(index);
              }}
            >
              <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {suggestion.title}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{suggestion.subtitle}</span>
                  <span className="inline-flex shrink-0 rounded-full border border-border/70 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    {resolveSuggestionKindLabel(suggestion.kind)}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-border/70 bg-card/65 px-3 py-2 text-[11px] text-muted-foreground">
        <span>Enter to open</span>
        <span>↑↓ to move</span>
        <span>Esc to dismiss</span>
      </div>
    </div>
  );
}
