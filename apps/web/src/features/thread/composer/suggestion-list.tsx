import { CommandIcon, FileIcon } from "@phosphor-icons/react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";
import type { Suggestion, Suggestions } from "./suggestions.tsx";

const titles = { mention: "Files", command: "Commands" } as const;

function statusLine(suggestions: Exclude<Suggestions, { state: "closed" | "ready" }>): string {
  const files = suggestions.kind === "mention";
  if (suggestions.state === "loading") return files ? "Searching files…" : "Loading commands…";
  if (suggestions.state === "failed")
    return files ? "Couldn't search the checkout" : "Couldn't load commands";
  if (!suggestions.query) return files ? "No files in this checkout" : "No commands available";
  return files
    ? `No files match “${suggestions.query}”`
    : `No commands match “/${suggestions.query}”`;
}

/**
 * The list above the composer, as wide as the writing area. The textarea keeps focus and drives
 * it with the arrow keys; while it loads or finds nothing it says so instead of vanishing.
 */
export function SuggestionList(props: {
  id: string;
  suggestions: Suggestions;
  active: number;
  onPick(item: Suggestion): void;
}) {
  const { suggestions } = props;
  if (suggestions.state === "closed") return null;
  const title = titles[suggestions.kind];
  return (
    <div className="glass absolute inset-x-0 bottom-full z-20 mb-2 rounded-xl p-1.5">
      <p className="px-2.5 pt-1 pb-1 text-[11px] leading-4 font-medium tracking-[0.02em] text-subtle-foreground">
        {title}
      </p>
      {suggestions.state === "ready" ? (
        <ul id={props.id} role="listbox" aria-label={title}>
          {suggestions.items.map((item, index) => (
            <li
              key={item.insert}
              id={`${props.id}-${index}`}
              role="option"
              aria-selected={index === props.active}
              // Keep the textarea focused: pick on mousedown, before blur.
              onMouseDown={(event) => {
                event.preventDefault();
                props.onPick(item);
              }}
              className={cn(
                "flex h-8 cursor-default items-center gap-2 rounded-lg px-2.5 text-ui leading-4",
                index === props.active && "bg-accent",
              )}
            >
              {item.kind === "mention" ? (
                <FileIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
              ) : (
                <CommandIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
              )}
              <span className={cn("shrink-0", item.kind === "command" && "font-mono text-[12px]")}>
                {item.label}
              </span>
              {item.detail && (
                <span
                  className={cn(
                    "min-w-0 truncate text-xs text-subtle-foreground",
                    item.kind === "mention" && "font-mono",
                  )}
                >
                  {item.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p
          role="status"
          className="flex h-8 items-center gap-2 px-2.5 text-ui leading-4 text-muted-foreground"
        >
          {suggestions.state === "loading" && <Spinner />}
          {statusLine(suggestions)}
        </p>
      )}
    </div>
  );
}
