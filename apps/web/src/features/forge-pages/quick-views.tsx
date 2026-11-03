import { cn } from "@/lib/cn.ts";

/**
 * How many a group or view holds, honestly: its total once every row is read; "2 of 12" when a
 * total is known but only some rows are; "12+" when more pages wait and no total is known.
 */
export function countWords(shown: number, total: number | undefined, complete: boolean): string {
  if (total !== undefined && total > shown) return `${shown} of ${total}`;
  if (total !== undefined) return String(total);
  return complete ? String(shown) : `${shown}+`;
}

export interface QuickView<T extends string> {
  id: T;
  label: string;
  count: string | undefined;
}

/**
 * A list's quick views ("Needs you", "All open", "Closed"…): words with their counts, one
 * pressed. They hold the list's state too, so there is no separate state menu.
 */
export function QuickViews<T extends string>(props: {
  label: string;
  views: readonly QuickView<T>[];
  /** The pressed view; none when the address asks for something no view names. */
  value: T | undefined;
  onValue(value: T): void;
}) {
  return (
    <div role="group" aria-label={props.label} className="flex shrink-0 gap-0.5">
      {props.views.map((view) => {
        const on = view.id === props.value;
        return (
          <button
            key={view.id}
            type="button"
            aria-pressed={on}
            onClick={() => props.onValue(view.id)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui whitespace-nowrap transition-colors duration-(--motion-fast) focus-ring",
              on ? "bg-hover text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {view.label}
            {view.count !== undefined && (
              <span className="text-subtle-foreground tabular-nums">{view.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
