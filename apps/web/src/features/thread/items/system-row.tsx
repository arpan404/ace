import { CaretRightIcon } from "@phosphor-icons/react";
import { formatClock } from "@ace/ui-core";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * Something that happened to the thread rather than in the conversation ("Resumed after
 * restart", "Stopped", "Context compacted"), as one muted row in the weight of "Worked for":
 * a glyph, the words, the time at the right. What ace sent on the person's behalf stays behind
 * the row's own caret, folded until asked for. Never a centred divider, never focused by itself.
 */
export function SystemRow(props: {
  text: string;
  icon: ReactNode;
  /** When it happened, ms since the epoch. */
  at?: number | undefined;
  /** What opening the row shows; without it the row is plain text. */
  children?: ReactNode;
  role?: "note" | "status";
}) {
  const [open, setOpen] = useState(false);
  const body = useId();
  const label = (
    <>
      <span className="shrink-0 text-subtle-foreground">{props.icon}</span>
      <span className="truncate">{props.text}</span>
    </>
  );
  return (
    <div role={props.role ?? "note"} aria-label={props.text}>
      <div className="flex min-h-8 items-center gap-3">
        {props.children ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={body}
            onClick={() => setOpen(!open)}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:text-foreground pointer-coarse:min-h-11"
          >
            {label}
            <CaretRightIcon
              aria-hidden
              size={14}
              className={cn(
                "shrink-0 text-subtle-foreground transition-transform duration-(--motion-base) ease-spring",
                open && "rotate-90",
              )}
            />
          </button>
        ) : (
          <p className="inline-flex min-w-0 items-center gap-1.5 text-ui text-muted-foreground">
            {label}
          </p>
        )}
        {props.at !== undefined && (
          <span className="ml-auto shrink-0 text-xs tabular-nums text-subtle-foreground">
            {formatClock(props.at)}
          </span>
        )}
      </div>
      {props.children && open && (
        <div
          id={body}
          className="fx-rise-in mt-1 max-h-72 overflow-auto pl-5 text-xs whitespace-pre-wrap break-words text-muted-foreground"
        >
          {props.children}
        </div>
      )}
    </div>
  );
}
