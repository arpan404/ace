import type { RefObject } from "react";
import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { MentionIcon } from "@/components/mention-chip.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import { catalogSourceLabel } from "@/lib/catalog.ts";
import type { Suggestion, Suggestions } from "./suggestions.tsx";

export function SuggestionList(props: {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  onDismiss(): void;
  suggestions: Suggestions;
  active: number;
  onPick(item: Suggestion): void;
}) {
  const { suggestions } = props;
  if (suggestions.state === "closed") return null;
  const title = suggestions.kind === "mention" ? "Files and threads" : "Add and commands";
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) props.onDismiss();
      }}
    >
      <PopoverContent
        ref={observeSuggestions}
        role="presentation"
        data-suggestions-popup
        side="top"
        sideOffset={8}
        anchor={() => props.anchor.current}
        collisionPadding={{ top: 48, right: 8, bottom: 8, left: 8 }}
        initialFocus={false}
        finalFocus={false}
        className="w-(--anchor-width) max-h-[min(420px,var(--available-height),calc(100dvh-56px))] overflow-x-hidden overflow-y-auto px-1.5 py-1"
      >
        {suggestions.state === "ready" ? (
          <ul id={props.id} role="listbox" aria-label={title}>
            {suggestions.items.map((item, index) => (
              <li key={item.entry?.id ?? item.threadId ?? item.insert} role="presentation">
                {(index === 0 || suggestions.items[index - 1]?.group !== item.group) && (
                  <p className="px-2.5 py-1 text-xs text-subtle-foreground">{item.group}</p>
                )}
                <div
                  id={`${props.id}-${index}`}
                  role="option"
                  aria-label={[
                    item.label,
                    item.detail,
                    item.entry && catalogSourceLabel(item.entry),
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-selected={index === props.active}
                  aria-disabled={item.entry?.invocation.type === "unavailable" || undefined}
                  ref={(el) => {
                    if (el && index === props.active) revealSuggestion(el);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    props.onPick(item);
                  }}
                  className={cn(
                    "flex h-9 cursor-default items-center gap-2 rounded-md px-2.5 text-ui leading-4",
                    index === props.active && "bg-accent",
                  )}
                >
                  <MentionIcon
                    kind={item.entry?.kind ?? (item.threadId ? "thread" : "file")}
                    action={
                      item.entry?.invocation.type === "action"
                        ? item.entry.invocation.action
                        : undefined
                    }
                  />
                  <span className="min-w-0 shrink truncate">{item.label}</span>
                  {item.detail && (
                    <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
                      {item.detail}
                    </span>
                  )}
                  {item.entry && item.entry.source.scope !== "ace" && (
                    <span className="shrink-0 text-xs text-subtle-foreground">
                      {catalogSourceLabel(item.entry)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p
            role="status"
            className="flex h-9 items-center gap-2 px-2.5 text-ui text-muted-foreground"
          >
            {suggestions.state === "loading" && <Spinner />}
            {suggestions.state === "loading"
              ? "Loading suggestions…"
              : suggestions.state === "failed"
                ? "Couldn't load suggestions. Close the menu and try again."
                : "No matching suggestions"}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Scroll only the suggestion surface; revealing a command must never move the document. */
export function revealSuggestion(item: HTMLElement): void {
  const surface = item.closest<HTMLElement>("[data-suggestions-popup]");
  if (!surface) return;
  const option = item.getBoundingClientRect();
  const bounds = surface.getBoundingClientRect();
  if (option.top < bounds.top + 4) surface.scrollTop += option.top - bounds.top - 4;
  else if (option.bottom > bounds.bottom - 4)
    surface.scrollTop += option.bottom - bounds.bottom + 4;
}

/** The portaled surface mounts after its owner; subscribe when that DOM node actually arrives. */
function observeSuggestions(element: HTMLDivElement | null): (() => void) | undefined {
  if (!element || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(() => {
    const active = element.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (active) revealSuggestion(active);
  });
  observer.observe(element);
  return () => observer.disconnect();
}
