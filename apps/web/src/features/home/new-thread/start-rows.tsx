import { useState } from "react";
import { formatAge } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { startRowLimit, type StartRow } from "./start-from-model.ts";

const row =
  "flex h-8 w-full min-w-0 items-center gap-3 rounded-md px-2.5 text-left text-ui transition-colors duration-(--motion-fast) focus-ring hover:bg-accent hover:text-foreground";

/**
 * One list of open work: the first few rows, then "Show N more" for the rest of what was loaded.
 * `none` says what an empty list means (a search with no matches).
 */
export function StartRows(props: {
  rows: readonly StartRow[];
  chosen: string | undefined;
  none: string;
  onPick(url: string): void;
}) {
  const now = useNow();
  const [all, setAll] = useState(false);
  if (!props.rows.length)
    return (
      <p className="flex h-8 items-center px-2.5 text-ui text-muted-foreground">{props.none}</p>
    );
  const shown = all ? props.rows : props.rows.slice(0, startRowLimit);
  const more = props.rows.length - shown.length;
  return (
    <ul className="flex flex-col">
      {shown.map((item) => (
        <li key={item.url}>
          <button
            type="button"
            aria-current={item.url === props.chosen ? "true" : undefined}
            onClick={() => props.onPick(item.url)}
            className={cn(
              row,
              "text-foreground/85",
              item.url === props.chosen && "bg-accent text-foreground",
            )}
          >
            <span className="w-11 shrink-0 text-muted-foreground tabular-nums">#{item.number}</span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.note && (
              <span
                className={cn(
                  "max-w-40 shrink-0 truncate text-xs",
                  item.note.failed ? "text-status-failed" : "text-muted-foreground",
                )}
              >
                {item.note.text}
              </span>
            )}
            {item.updatedAt !== undefined && (
              <span className="w-7 shrink-0 text-right text-xs text-subtle-foreground tabular-nums">
                {formatAge(item.updatedAt, now)}
              </span>
            )}
          </button>
        </li>
      ))}
      {more > 0 && (
        <li>
          <button
            type="button"
            onClick={() => setAll(true)}
            className={cn(row, "text-muted-foreground")}
          >
            Show {more} more
          </button>
        </li>
      )}
    </ul>
  );
}
