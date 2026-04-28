import { Clock3Icon, GlobeIcon, SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import type { BrowserSearchEngine } from "@ace/contracts/settings";
import { cn } from "~/lib/utils";
import type { BrowserSuggestion } from "~/lib/browser/history";
import { BROWSER_NEW_TAB_TITLE } from "~/lib/browser/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BROWSER_SEARCH_ENGINE_OPTIONS, resolveSuggestionKindLabel } from "~/lib/browser/types";

function resolveSearchEngineLabel(browserSearchEngine: BrowserSearchEngine): string {
  return (
    BROWSER_SEARCH_ENGINE_OPTIONS.find((option) => option.value === browserSearchEngine)?.label ??
    "Search"
  );
}

export function BrowserNewTabPanel(props: {
  browserSearchEngine: BrowserSearchEngine;
  onSubmitQuery: (query: string) => void;
}) {
  const { browserSearchEngine, onSubmitQuery } = props;
  const [query, setQuery] = useState("");
  const searchEngineLabel = resolveSearchEngineLabel(browserSearchEngine);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary)_3%,transparent)_0%,transparent_50%)] px-5 py-8 sm:px-8 lg:px-12">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8">
        <div className="space-y-3 text-center">
          <div className="inline-flex items-center gap-1.5 self-center rounded-full border border-border/15 bg-card/20 px-2.5 py-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground/40 uppercase">
            <SearchIcon className="size-2.5" />
            {searchEngineLabel}
          </div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground/85 sm:text-3xl">
              {BROWSER_NEW_TAB_TITLE}
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground/35">
              Search the web or enter an address without leaving the browser shell.
            </p>
          </div>
        </div>

        <form
          className="mx-auto flex w-full max-w-2xl flex-col gap-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (query.trim().length === 0) {
              return;
            }
            onSubmitQuery(query);
          }}
        >
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 transition-colors duration-150 focus-within:border-primary/30">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground/35" />
            <Input
              className="h-auto w-full flex-1 border-0 bg-transparent px-0 text-base"
              unstyled
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search with ${searchEngineLabel} or enter an address`}
              aria-label="Search the web or enter an address"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button
              type="submit"
              size="sm"
              className="shrink-0 rounded-lg px-4"
              disabled={query.trim().length === 0}
            >
              Go
            </Button>
          </div>
        </form>
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
    <div className="absolute inset-x-0 top-[calc(100%+0.35rem)] z-20 overflow-hidden rounded-xl border border-border/20 bg-popover/95 shadow-lg shadow-black/[0.03] backdrop-blur-xl">
      <div className="max-h-80 overflow-y-auto py-0.5">
        {suggestions.map((suggestion, index) => {
          const isActive = index === activeIndex;
          const icon =
            suggestion.kind === "history" ? (
              <Clock3Icon className="size-3.5" />
            ) : suggestion.kind === "tab" ? (
              <GlobeIcon className="size-3.5" />
            ) : (
              <SearchIcon className="size-3.5" />
            );

          return (
            <button
              key={suggestion.id}
              ref={(element) => {
                suggestionItemRefs.current[index] = element;
              }}
              type="button"
              className={cn(
                "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-all duration-100",
                isActive ? "bg-foreground/[0.04] text-foreground" : "hover:bg-foreground/[0.02]",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(suggestion);
              }}
              onMouseEnter={() => {
                onHighlight(index);
              }}
            >
              <span
                className={cn(
                  "mt-0.5 shrink-0",
                  isActive ? "text-foreground/50" : "text-muted-foreground/30",
                )}
              >
                {icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground/85">
                  {suggestion.title}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/35">
                  <span className="truncate">{suggestion.subtitle}</span>
                  <span className="inline-flex shrink-0 rounded-full border border-border/20 bg-background/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/40">
                    {resolveSuggestionKindLabel(suggestion.kind)}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-border/12 bg-card/20 px-3 py-1.5 text-[10px] text-muted-foreground/30">
        <span>Enter to open</span>
        <span>↑↓ to move</span>
        <span>Esc to dismiss</span>
      </div>
    </div>
  );
}
